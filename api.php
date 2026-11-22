<?php
/**
 * Notary log API — server-side storage for the notary log.
 *
 * Data lives in a SQLite database outside the webroot (/home/tmp/log-data),
 * so it can never be fetched by URL. Every endpoint requires an
 * authenticated session cookie; the PIN is verified server-side and stored
 * as a salted hash, never in this file or in any response.
 *
 * Endpoints (all under api.php?action=...):
 *   status   GET   -> { authenticated: bool }
 *   login    POST  { pin }                 -> sets session cookie
 *   logout   POST  -> clears session
 *   list     GET   -> { entries: [...] }
 *   save     POST  { entry: {...} }        -> create or update
 *   delete   POST  { id }                  -> delete
 *   upload   POST  { id?, image }          -> attach an image to an entry
 *   image    GET   ?id=<entry>&file=<name> -> serve an image (auth required)
 */

declare(strict_types=1);

const DATA_DIR = '/home/tmp/log-data';
const DB_FILE = DATA_DIR . '/notary.db';
const UPLOAD_DIR = DATA_DIR . '/uploads';
const PIN_HASH_FILE = DATA_DIR . '/pin.hash';
const SESSION_NAME = 'notary_session';
const SESSION_TTL = 60 * 60 * 8;      // 8 hours
const MAX_ATTEMPTS = 5;                // wrong PINs before lockout
const LOCKOUT_SECONDS = 15 * 60;       // lockout length
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

// The identification types the form offers. The server validates against
// this list rather than trusting whatever the client sent.
const ALLOWED_IDENTIFICATION_TYPES = [
    "Driver's License",
    'Passport',
    'State ID',
    'Thumb Print',
];

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function respond(int $status, array $payload): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, private');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $status = 400): never
{
    respond($status, ['ok' => false, 'error' => $message]);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function ensure_dirs(): void
{
    foreach ([DATA_DIR, UPLOAD_DIR] as $dir) {
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            fail('Server storage is not configured.', 500);
        }
    }
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    ensure_dirs();
    try {
        $pdo = new PDO('sqlite:' . DB_FILE);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        error_log('notary log: cannot open database: ' . $e->getMessage());
        fail('The log database is unavailable.', 500);
    }
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA foreign_keys = ON');

    // Migrate an existing database. ALTER TABLE ADD COLUMN is not
    // idempotent, so each column is checked before it is added.
    $existing = [];
    foreach ($pdo->query('PRAGMA table_info(entries)')->fetchAll() as $col) {
        $existing[] = $col['name'];
    }
    foreach ([
        'identification_type'   => "TEXT NOT NULL DEFAULT ''",
        'identification_number' => "TEXT NOT NULL DEFAULT ''",
        'entry_time'            => "TEXT NOT NULL DEFAULT ''",
        'venue'                 => "TEXT NOT NULL DEFAULT ''",
        'county'                => "TEXT NOT NULL DEFAULT ''",
        'signer_address'        => "TEXT NOT NULL DEFAULT ''",
    ] as $column => $definition) {
        if (!in_array($column, $existing, true)) {
            $pdo->exec('ALTER TABLE entries ADD COLUMN ' . $column . ' ' . $definition);
        }
    }

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS entries (
            id                TEXT PRIMARY KEY,
            log_date          TEXT NOT NULL,
            client_name       TEXT NOT NULL,
            document_type     TEXT NOT NULL DEFAULT "",
            document_type_other TEXT NOT NULL DEFAULT "",
            notarization_type TEXT NOT NULL DEFAULT "",
            notes             TEXT NOT NULL DEFAULT "",
            identification_type TEXT NOT NULL DEFAULT "",
            identification_number TEXT NOT NULL DEFAULT "",
            entry_time        TEXT NOT NULL DEFAULT "",
            venue             TEXT NOT NULL DEFAULT "",
            county            TEXT NOT NULL DEFAULT "",
            signer_address    TEXT NOT NULL DEFAULT "",
            image_file        TEXT,
            created_at        TEXT NOT NULL,
            updated_at        TEXT NOT NULL
        )'
    );
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS auth (
            id            INTEGER PRIMARY KEY CHECK (id = 1),
            pin_hash      TEXT NOT NULL,
            salt          TEXT NOT NULL,
            attempts      INTEGER NOT NULL DEFAULT 0,
            locked_until  INTEGER NOT NULL DEFAULT 0,
            updated_at    TEXT NOT NULL
        )'
    );
    return $pdo;
}

// ---------------------------------------------------------------------------
// PIN
// ---------------------------------------------------------------------------

/**
 * Set the PIN on first run. Stored as PBKDF2-HMAC-SHA256 with a random salt.
 * The PIN itself is never written to disk.
 */
function pin_hash(string $pin): array
{
    $salt = bin2hex(random_bytes(16));
    $hash = hash_pbkdf2('sha256', $pin, $salt, 120000);
    return ['hash' => $hash, 'salt' => $salt];
}

function ensure_pin_initialised(): void
{
    $pdo = db();
    $row = $pdo->query('SELECT id FROM auth WHERE id = 1')->fetch();
    if ($row) {
        return;
    }
    // First run: take the PIN from a one-time setup file, then delete it.
    $setup = DATA_DIR . '/pin.setup';
    if (!is_file($setup)) {
        fail('The log PIN has not been configured yet.', 500);
    }
    $pin = trim((string)file_get_contents($setup));
    @unlink($setup);
    if ($pin === '') {
        fail('The log PIN could not be configured.', 500);
    }
    $h = pin_hash($pin);
    $stmt = $pdo->prepare(
        'INSERT INTO auth (id, pin_hash, salt, attempts, locked_until, updated_at)
         VALUES (1, ?, ?, 0, 0, ?)'
    );
    $stmt->execute([$h['hash'], $h['salt'], gmdate('c')]);
}

function verify_pin(string $pin): bool
{
    $pdo = db();
    $row = $pdo->query('SELECT pin_hash, salt FROM auth WHERE id = 1')->fetch();
    if (!$row) {
        return false;
    }
    $candidate = hash_pbkdf2('sha256', $pin, $row['salt'], 120000);
    return hash_equals($row['pin_hash'], $candidate);
}

function auth_state(): array
{
    $pdo = db();
    $row = $pdo->query('SELECT attempts, locked_until FROM auth WHERE id = 1')->fetch();
    if (!$row) {
        return ['attempts' => 0, 'locked_until' => 0];
    }
    return ['attempts' => (int)$row['attempts'], 'locked_until' => (int)$row['locked_until']];
}

function record_failed_attempt(): void
{
    $pdo = db();
    $state = auth_state();
    $attempts = $state['attempts'] + 1;
    $lockedUntil = $state['locked_until'];
    if ($attempts >= MAX_ATTEMPTS) {
        $lockedUntil = time() + LOCKOUT_SECONDS;
        $attempts = 0;
    }
    $stmt = $pdo->prepare('UPDATE auth SET attempts = ?, locked_until = ?, updated_at = ? WHERE id = 1');
    $stmt->execute([$attempts, $lockedUntil, gmdate('c')]);
}

function clear_failed_attempts(): void
{
    $pdo = db();
    $stmt = $pdo->prepare('UPDATE auth SET attempts = 0, locked_until = 0, updated_at = ? WHERE id = 1');
    $stmt->execute([gmdate('c')]);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function session_start_if_needed(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_name(SESSION_NAME);
    session_set_cookie_params([
        'lifetime' => SESSION_TTL,
        'path'     => '/',
        'httponly' => true,
        'secure'   => !empty($_SERVER['HTTPS']),
        'samesite' => 'Lax',
    ]);
    @session_start();
}

function is_authenticated(): bool
{
    session_start_if_needed();
    if (empty($_SESSION['notary_authenticated'])) {
        return false;
    }
    $started = (int)($_SESSION['notary_auth_started'] ?? 0);
    if ($started > 0 && (time() - $started) > SESSION_TTL) {
        $_SESSION = [];
        return false;
    }
    return true;
}

function require_auth(): void
{
    if (!is_authenticated()) {
        fail('Not signed in.', 401);
    }
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function json_input(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return $_POST;
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : $_POST;
}

function clean_text($value, int $maxLen): string
{
    if (!is_string($value)) {
        return '';
    }
    // Strip control characters, then trim, then clamp the length.
    $value = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $value) ?? '';
    $value = trim($value);
    if (function_exists('mb_substr')) {
        return mb_substr($value, 0, $maxLen);
    }
    return substr($value, 0, $maxLen);
}

function valid_date(string $value): bool
{
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m)) {
        return false;
    }
    return checkdate((int)$m[2], (int)$m[3], (int)$m[1]);
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function entry_to_row(array $r): array
{
    return [
        'id'                => $r['id'],
        'date'              => $r['log_date'],
        'clientName'        => $r['client_name'],
        'documentType'      => $r['document_type'],
        'documentTypeOther' => $r['document_type_other'],
        'notarizationType'  => $r['notarization_type'],
        'notes'             => $r['notes'],
        'identificationType' => $r['identification_type'],
        'identificationNumber' => $r['identification_number'],
        'entryTime' => $r['entry_time'],
        'venue' => $r['venue'],
        'county' => $r['county'],
        'signerAddress' => $r['signer_address'],
        'hasImage'          => $r['image_file'] !== null && $r['image_file'] !== '',
        'createdAt'         => $r['created_at'],
        'updatedAt'         => $r['updated_at'],
    ];
}

function handle_list(): never
{
    require_auth();
    $rows = db()->query('SELECT * FROM entries ORDER BY log_date DESC, created_at DESC')->fetchAll();
    $entries = array_map('entry_to_row', $rows);
    respond(200, ['ok' => true, 'entries' => $entries]);
}

function handle_save(): never
{
    require_auth();
    $input = json_input();
    $entry = is_array($input['entry'] ?? null) ? $input['entry'] : $input;

    $id = clean_text($entry['id'] ?? '', 64);
    $date = clean_text($entry['date'] ?? '', 10);
    $clientName = clean_text($entry['clientName'] ?? '', 120);
    $documentType = clean_text($entry['documentType'] ?? '', 80);
    $documentTypeOther = clean_text($entry['documentTypeOther'] ?? '', 200);
    $notarizationType = clean_text($entry['notarizationType'] ?? '', 80);
    $notes = clean_text($entry['notes'] ?? '', 2000);
    $identificationType = clean_text($entry['identificationType'] ?? '', 80);
    $identificationNumber = clean_text($entry['identificationNumber'] ?? '', 200);
    $entryTime = clean_text($entry['entryTime'] ?? '', 10);
    $venue = clean_text($entry['venue'] ?? '', 160);
    $county = clean_text($entry['county'] ?? '', 80);
    $signerAddress = clean_text($entry['signerAddress'] ?? '', 240);

    if (!valid_date($date)) {
        fail('A valid date is required.');
    }
    if ($clientName === '') {
        fail('A client name is required.');
    }
    if ($documentType === '') {
        fail('Select a document type.');
    }
    if ($documentType === 'Other' && $documentTypeOther === '') {
        fail('Describe the document type.');
    }
    if ($notarizationType === '') {
        fail('Select a notarization type.');
    }
    if ($identificationType !== '' && !in_array($identificationType, ALLOWED_IDENTIFICATION_TYPES, true)) {
        fail('Select a valid identification type.');
    }
    if ($identificationNumber !== '' && $identificationType === '') {
        fail('Select an identification type.');
    }
    // RCW 42.45.180 requires the journal to record the time and place of
    // the notarial act. The time is HH:MM in 24-hour form.
    if ($entryTime !== '' && !preg_match('/^\d{2}:\d{2}$/', $entryTime)) {
        fail('Enter the time of the notarial act as HH:MM.');
    }
    if ($venue === '' || $county === '') {
        fail('Enter the venue and county of the notarial act.');
    }

    $pdo = db();
    $now = gmdate('c');

    if ($id === '') {
        $id = bin2hex(random_bytes(16));
        $stmt = $pdo->prepare(
            'INSERT INTO entries
                (id, log_date, client_name, document_type, document_type_other,
                 notarization_type, notes, identification_type,
                 identification_number, entry_time, venue, county,
                 signer_address, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $id, $date, $clientName, $documentType, $documentTypeOther,
            $notarizationType, $notes, $identificationType,
            $identificationNumber, $entryTime, $venue, $county,
            $signerAddress, $now, $now,
        ]);
    } else {
        $stmt = $pdo->prepare(
            'UPDATE entries SET
                log_date = ?, client_name = ?, document_type = ?,
                document_type_other = ?, notarization_type = ?, notes = ?,
                identification_type = ?, identification_number = ?,
                entry_time = ?, venue = ?, county = ?, signer_address = ?,
                updated_at = ?
             WHERE id = ?'
        );
        $stmt->execute([
            $date, $clientName, $documentType, $documentTypeOther,
            $notarizationType, $notes, $identificationType,
            $identificationNumber, $entryTime, $venue, $county,
            $signerAddress, $now, $id,
        ]);
        if ($stmt->rowCount() === 0) {
            $exists = $pdo->prepare('SELECT COUNT(*) FROM entries WHERE id = ?');
            $exists->execute([$id]);
            if ((int)$exists->fetchColumn() === 0) {
                fail('That entry could not be found.', 404);
            }
        }
    }

    $row = $pdo->prepare('SELECT * FROM entries WHERE id = ?');
    $row->execute([$id]);
    $result = $row->fetch();
    respond(200, ['ok' => true, 'entry' => entry_to_row($result)]);
}

function handle_delete(): never
{
    require_auth();
    $input = json_input();
    $id = clean_text($input['id'] ?? '', 64);
    if ($id === '') {
        fail('An entry id is required.');
    }
    $pdo = db();

    // Remove the attached image file along with the entry.
    $row = $pdo->prepare('SELECT image_file FROM entries WHERE id = ?');
    $row->execute([$id]);
    $existing = $row->fetch();
    if ($existing && !empty($existing['image_file'])) {
        $path = UPLOAD_DIR . '/' . basename($existing['image_file']);
        if (is_file($path)) {
            @unlink($path);
        }
    }

    $stmt = $pdo->prepare('DELETE FROM entries WHERE id = ?');
    $stmt->execute([$id]);
    respond(200, ['ok' => true]);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function safe_extension(string $mime): ?string
{
    return match ($mime) {
        'image/jpeg' => 'jpg',
        'image/png'  => 'png',
        'image/webp' => 'webp',
        'image/heic' => 'heic',
        default      => null,
    };
}

function handle_upload(): never
{
    require_auth();
    if (empty($_FILES['image'])) {
        fail('No image was uploaded.', 400);
    }
    $file = $_FILES['image'];
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        fail('The image upload failed.', 400);
    }
    if (($file['size'] ?? 0) > MAX_UPLOAD_BYTES) {
        fail('The image is larger than 8 MB.', 413);
    }

    $mime = '';
    if (function_exists('finfo_open')) {
        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        $mime = (string)finfo_file($finfo, $file['tmp_name']);
        finfo_close($finfo);
    }
    $ext = safe_extension($mime);
    if ($ext === null) {
        fail('The file must be a JPEG, PNG, WebP or HEIC image.', 415);
    }

    $id = clean_text($_POST['id'] ?? '', 64);
    $pdo = db();

    if ($id === '') {
        $id = bin2hex(random_bytes(16));
    } else {
        $exists = $pdo->prepare('SELECT COUNT(*) FROM entries WHERE id = ?');
        $exists->execute([$id]);
        if ((int)$exists->fetchColumn() === 0) {
            fail('That entry could not be found.', 404);
        }
    }

    ensure_dirs();
    $fileName = $id . '-' . bin2hex(random_bytes(6)) . '.' . $ext;
    $target = UPLOAD_DIR . '/' . $fileName;

    $moved = is_uploaded_file($file['tmp_name'])
        ? move_uploaded_file($file['tmp_name'], $target)
        : rename($file['tmp_name'], $target);
    if (!$moved) {
        fail('The image could not be saved.', 500);
    }
    @chmod($target, 0600);

    // Replace any previous image for this entry.
    $prev = $pdo->prepare('SELECT image_file FROM entries WHERE id = ?');
    $prev->execute([$id]);
    $previous = $prev->fetch();
    if ($previous && !empty($previous['image_file'])) {
        $oldPath = UPLOAD_DIR . '/' . basename($previous['image_file']);
        if (is_file($oldPath) && basename($oldPath) !== $fileName) {
            @unlink($oldPath);
        }
    }

    $stmt = $pdo->prepare('UPDATE entries SET image_file = ?, updated_at = ? WHERE id = ?');
    $stmt->execute([$fileName, gmdate('c'), $id]);

    respond(200, ['ok' => true, 'id' => $id, 'hasImage' => true]);
}

function handle_image(): never
{
    require_auth();
    $id = clean_text($_GET['id'] ?? '', 64);
    if ($id === '') {
        fail('Not found.', 404);
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT image_file FROM entries WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row || empty($row['image_file'])) {
        fail('Not found.', 404);
    }

    // The filename is looked up from the entry id, so the client never has to
    // know it. A "file" parameter, if supplied, must still match — that
    // stops a stale URL from serving a replaced image.
    $file = basename($row['image_file']);
    $requested = clean_text($_GET['file'] ?? '', 128);
    if ($requested !== '' && !hash_equals($row['image_file'], $requested)) {
        fail('Not found.', 404);
    }

    $path = UPLOAD_DIR . '/' . $file;
    if (!is_file($path)) {
        fail('Not found.', 404);
    }

    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    $types = [
        'jpg'  => 'image/jpeg',
        'png'  => 'image/png',
        'webp' => 'image/webp',
        'heic' => 'image/heic',
    ];
    $mime = $types[$ext] ?? 'application/octet-stream';

    header('Content-Type: ' . $mime);
    header('Content-Length: ' . (string)filesize($path));
    header('Content-Disposition: inline; filename="' . basename($path) . '"');
    header('Cache-Control: no-store, private');
    header('X-Content-Type-Options: nosniff');
    readfile($path);
    exit;
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

function handle_login(): never
{
    ensure_pin_initialised();
    session_start_if_needed();

    $state = auth_state();
    if ($state['locked_until'] > time()) {
        $wait = $state['locked_until'] - time();
        fail('Too many attempts. Try again in ' . (int)ceil($wait / 60) . ' minute(s).', 429);
    }

    $input = json_input();
    $pin = is_string($input['pin'] ?? null) ? trim($input['pin']) : '';

    if ($pin === '' || !verify_pin($pin)) {
        record_failed_attempt();
        fail('Incorrect PIN.', 401);
    }

    clear_failed_attempts();
    session_regenerate_id(true);
    $_SESSION['notary_authenticated'] = true;
    $_SESSION['notary_auth_started'] = time();
    respond(200, ['ok' => true]);
}

function handle_logout(): never
{
    session_start_if_needed();
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', [
            'expires'  => time() - 42000,
            'path'     => $p['path'],
            'domain'   => $p['domain'],
            'secure'   => $p['secure'],
            'httponly' => $p['httponly'],
            'samesite' => $p['samesite'] ?? 'Lax',
        ]);
    }
    session_destroy();
    respond(200, ['ok' => true]);
}

function handle_status(): never
{
    ensure_pin_initialised();
    respond(200, ['ok' => true, 'authenticated' => is_authenticated()]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

ensure_dirs();
ensure_pin_initialised();

$action = clean_text($_GET['action'] ?? '', 40);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    switch ($action) {
        case 'status':
            handle_status();
        case 'login':
            if ($method !== 'POST') {
                fail('Method not allowed.', 405);
            }
            handle_login();
        case 'logout':
            handle_logout();
        case 'list':
            handle_list();
        case 'save':
            if ($method !== 'POST') {
                fail('Method not allowed.', 405);
            }
            handle_save();
        case 'delete':
            if ($method !== 'POST') {
                fail('Method not allowed.', 405);
            }
            handle_delete();
        case 'upload':
            if ($method !== 'POST') {
                fail('Method not allowed.', 405);
            }
            handle_upload();
        case 'image':
            handle_image();
        default:
            fail('Unknown action.', 404);
    }
} catch (Throwable $e) {
    error_log('notary log api error: ' . $e->getMessage());
    fail('Something went wrong on the server.', 500);
}

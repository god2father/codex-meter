# Passport integrated connection

Meter includes the pinned Bridge sources and ws 8.22.0, but does not bundle Node. It automatically discovers an installed Node 22 or newer through PATH, Homebrew and nvm locations and fills the runtime configuration. If no supported installation is found, it reports that Node must be installed. Users need no manual runtime path, script path, environment file, certificate or IP entry. Settings contains the connection switch, device state and **Bind device** action in the same panel.

Binding detects local private IPv4 interfaces through the detected local Node runtime, generates a TLS certificate covering those addresses and loopback, and creates separate random control/device credentials. Private keys and credentials stay in the application configuration directory with Unix directory mode 0700 and file mode 0600. Selecting Bind device starts Bridge and displays a random four-digit numeric code valid for five minutes. The phone enters this code directly in the automatic captive setup page along with Wi-Fi. Passport discovers Meter using UDP 8799 and retrieves an AES-256-GCM encrypted envelope containing the device credential, public certificate, URI, NTP hostname and authenticated time. The four digits authenticate both peers using ESP-IDF-compatible SRP-6a (3072-bit group/SHA-512), with HKDF-SHA256 deriving the encryption key. The code and verifier are not transmitted to Meter over the LAN; no visual comparison, checkbox or computer approval is required. Credentials are released only after mutual proof validation. Each five-minute code permits five new exchanges, including wrong-code/abandoned attempts. Exchanges expire after 30 seconds; retries require no manual approval. Certificate and credential checks over HTTPS must succeed before the single physical confirmation commits binding. Refresh invalidates the previous code; an authenticated device connection retires it. Cancellable worker threads keep expensive computer cryptography off the main loop. Normal pairing needs no USB.

The service remains off until explicitly enabled. Meter supervises only its own process group. It refuses occupied ports, probes certificate-verified HTTPS, distinguishes device connection from service startup and stops its service at quit. Auto-provisioning uses a free port from 8766–8795 to avoid the earlier externally managed service at 8765. Existing external configurations and services are preserved; binding while an external service is stopped migrates Meter to its internal service.

Repeated binding preserves credentials on the same network. If the computer moves to an address not covered by its existing certificate, disable the switch and bind again. Previous configuration is retained privately; the device must confirm the replacement certificate.

## Development

Use Node 22 or newer and run `npm run bridge:prepare` to populate locked production dependencies, then `npm run dev`. Preparation records Bridge resource hashes and marks the runtime as external. Node executables are excluded from bundle resources. Bridge dependencies and their license files accompany the resources. Current local acceptance covers macOS Apple Silicon; other targets require runtime-discovery and acceptance checks before release.

Validation includes frontend build, Rust provisioning/credential/permissions tests, repeat provisioning, four-digit leading-zero handling, code expiry, automatic authentication, private storage and stale-session rejection, and the actual bundled Bridge responding over trusted HTTPS with isolated Codex IPC. Bridge protocol tests run against the pinned upstream source. Phone-first pairing still requires on-device acceptance.

Development and production Tauri entry points prepare locked Bridge dependencies and validate the resource index automatically. CI also prepares resources before Rust tests. Node remains external. Exchanges expire after 30 seconds; a still-valid code can start a new exchange when attempts remain. A single physical save confirmation finishes pairing.

## Selecting a chat on Passport

Updated Passport firmware opens a four-item local chat picker from idle OK.
The authenticated device chooses its own target; the desktop's visible chat does
not change that target. Bridge lists non-archived metadata through read-only
`thread/list`, validates page revisions, refuses switching during approvals,
and waits for the selected thread's IPC snapshot. The managed service stores
only its selected ID/title in private `selected-chat.json`, preserving pairing.
An unloaded desktop chat may remain waiting until opened.

## Message bubbles and synchronization

The matched firmware renders the latest two text messages in distinct right-purple user and left-mint assistant bubbles, including consecutive messages of the same role. Bubbles omit role headings and short messages fit their text. The Bridge sends role-tagged `messages` plus legacy `content`; oversized frames discard legacy content before role-tagged messages. Each body is bounded to 450 UTF-8 bytes. Tools, reasoning and empty text are excluded. Firmware can reconstruct its scrolling content from messages-only frames.

Authenticated `history` requests carry threadId, requestId, page and an optional revision. Page zero is the latest two messages. The first read freezes a snapshot and returns a revision; later requests use it without rereading history. Older out-of-range requests clamp to the oldest page. Responses include page, hasOlder, hasNewer and role-tagged messages. Thread/device generation checks discard stale responses, and approvals take priority. Busy or invalid requests return an explicit error. Disconnects and chat selection invalidate the snapshot. The computer retains at most 200002 filtered bounded messages; the device only retains its current page.

UP at the top loads an older page at its bottom; DOWN at the bottom loads a newer page at its top. Page-zero return resumes live text. Live text does not override history. Loading/error indicators preserve existing text and retry remains available. The 450-byte message limit still applies to history.

When IPC snapshots omit history, a separate read-only app-server calls `thread/read` with `includeTurns: true`, at most every ten seconds while connected and missing live text. It does not resume threads or start turns. Reads load history on the computer before extracting the two device messages, so desktop cost grows with history. Thread, connection and live-content generation checks reject stale responses. Read errors preserve existing content. Pending approvals/questions omit message bodies and take priority on the device.

Both Meter and firmware must be updated, and the running Meter process restarted after replacing resources. Same-chat refreshes preserve scroll; target changes reset it. The top status bar contains quota and battery; all device icons are original integer 7-by-7 pixel sprites.

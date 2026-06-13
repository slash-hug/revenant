# Obsidian Local REST API — Research Notes (WS-D / D1)

Source: <https://github.com/coddingtonbear/obsidian-local-rest-api>
Research date: 2026-06-13

---

## Plugin

**Name:** Local REST API (by Adam Coddington)
**Installation:** Obsidian Community Plugins → search "Local REST API"
**Configuration:** Settings → Local REST API → copy API key

---

## Server defaults

| Setting | Value |
|---------|-------|
| Default port (HTTPS) | **27124** |
| Default port (HTTP, optional) | **27123** |
| Protocol default | HTTPS with self-signed certificate |
| Bind address | `127.0.0.1` (localhost only) |
| Status endpoint (no auth required) | `GET https://127.0.0.1:27124/` |

To enable the optional HTTP server (avoids TLS certificate complexity): Settings → Local REST API → "Enable HTTP server". For `revenant` v1, target HTTP on port 27123 (no certificate trust needed for a loopback-only tool); fall back gracefully if neither is reachable.

---

## Authentication

All endpoints except `GET /` require a Bearer token.

```
Authorization: Bearer <api-key>
```

The API key is a UUID displayed in plugin settings. The user copies it once; `revenant` stores it in the OS keychain (macOS Keychain / Windows Credential Manager via the `keyring` crate) — never in plaintext settings JSON (decision C14).

---

## Endpoint reference

### Status check (connectivity probe)

```
GET /
```

- No auth required.
- Returns `200 OK` when the server is running.
- Use this to distinguish "REST not running" (connection refused / timeout) from "REST misconfigured" (returns 401 with the stored key).
- Response body: not documented; treat any `200` as success.

### Create or overwrite a vault file

```
PUT /vault/{path}
```

**Headers:**
```
Authorization: Bearer <api-key>
Content-Type: text/markdown
```

**Path:** URL-encoded relative vault path, e.g., `Reviews/2026-06-review.md`

**Body:** Raw markdown text (file content in full).

**Response codes (inferred from REST conventions + plugin source):**

| Code | Meaning |
|------|---------|
| 200 | File updated |
| 201 | File created |
| 400 | Bad request |
| 401 | Missing or invalid API key |
| 404 | Vault path not found |
| 422 | Validation error |

### PATCH a frontmatter field

```
PATCH /vault/{path}
```

**Headers:**
```
Authorization: Bearer <api-key>
Content-Type: application/json
Operation: replace
Target-Type: frontmatter
Target: <field-name>
```

**Body:** JSON value for the field, e.g., `"in-review"`.

### List vault files

```
GET /vault/
```

**Headers:**
```
Authorization: Bearer <api-key>
```

Returns JSON listing of vault contents.

---

## Revenant integration design (for `obsidian.rs`)

### Reachability check sequence

```
1. GET /                 → connection refused  → "REST not running" (use filesystem fallback)
2. GET /                 → 200 OK              → server is up
3. PUT /vault/{path}     → 401                 → "REST misconfigured" (bad/missing key)
                         → 200/201             → success
```

### PUT request shape (Rust pseudocode)

```rust
let url = format!("http://127.0.0.1:27123/vault/{}", encode_path(vault_relative_path));
let response = client
    .put(&url)
    .header("Authorization", format!("Bearer {}", api_key))
    .header("Content-Type", "text/markdown")
    .body(markdown_content)
    .send()
    .await?;
```

Use HTTP (port 27123) as the default in v1 to avoid self-signed certificate trust issues. HTTP is loopback-only and acceptable for a local desktop tool.

### Error taxonomy

| Condition | Error kind | User message |
|-----------|-----------|--------------|
| Connection refused on `GET /` | `ObsidianError::NotRunning` | "Obsidian is not running or the Local REST API plugin is not enabled." |
| `401` on PUT | `ObsidianError::Misconfigured` | "API key is invalid. Open Settings → Obsidian to reconfigure." |
| Other non-2xx | `ObsidianError::HttpError(status)` | "Export failed (HTTP {status}). Check the Obsidian console." |

### Filesystem fallback

When `ObsidianError::NotRunning`, fall back to direct filesystem copy into the configured vault directory. Emit a `configure_obsidian_prompt` event on first fallback so the frontend can show a one-time setup prompt.

---

## TLS note

The plugin uses a self-signed certificate on port 27124. In v1, default to the HTTP port (27123) to avoid certificate pinning complexity. If the user explicitly enables HTTPS-only mode, `reqwest`'s `danger_accept_invalid_certs(true)` can be used — but document the trade-off. The connection is loopback-only so the risk is low.

---

## References

- Plugin repo: <https://github.com/coddingtonbear/obsidian-local-rest-api>
- Interactive API docs: <https://coddingtonbear.github.io/obsidian-local-rest-api/>

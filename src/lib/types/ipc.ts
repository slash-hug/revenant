/**
 * IPC contract types — mirrors src-tauri/src/ipc.rs.
 * Pinned by WS-A (A2); consumed by WS-C (frontend) and WS-B/D (Rust stubs).
 *
 * Commands: open_file, save_file, load_annotations, save_annotations,
 *           generate_review, export_obsidian, get_settings, set_settings.
 * Events:   open_file_request, file_changed.
 */

// ---------------------------------------------------------------------------
// Shared primitive types
// ---------------------------------------------------------------------------

export interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/** Precise source-editor anchor: line/char range. */
export interface SourceAnchor {
  start_line: number;
  start_char: number;
  end_line: number;
  end_char: number;
  quoted_text: string;
  context_before: string;
  context_after: string;
}

/** Block-level anchor used when preview-selection lands on a transformed block
 *  (Mermaid, table, footnote). The block_id corresponds to a data-block-id
 *  attribute emitted by the renderer. */
export interface BlockAnchor {
  block_id: string;
  block_type: 'mermaid' | 'table' | 'footnote' | 'generic';
  quoted_text: string;
}

export type AnchorV1 = { type: 'source'; anchor: SourceAnchor } | { type: 'block'; anchor: BlockAnchor };

export type AnnotationStatus = 'open' | 'resolved' | 'detached';

export interface Annotation {
  id: string;
  anchor: AnchorV1;
  body: string;
  status: AnnotationStatus;
  created_at: string; // ISO 8601
  resolved_at?: string;
}

export interface Sidecar {
  schema_version: 1;
  doc_path: string;
  doc_content_hash: string;
  general_notes: string;
  annotations: Annotation[];
}

// ---------------------------------------------------------------------------
// Commands — request / response shapes
// ---------------------------------------------------------------------------

export interface OpenFileArgs {
  path: string;
}

export interface OpenFileResult {
  path: string;
  content: string;
  content_hash: string;
  frontmatter?: Record<string, unknown>;
}

export interface SaveFileArgs {
  path: string;
  content: string;
  expected_hash: string;
}

export interface SaveFileResult {
  new_hash: string;
}

export interface SaveFileConflict {
  conflict: true;
  disk_hash: string;
}

export type SaveFileResponse = SaveFileResult | SaveFileConflict;

export interface LoadAnnotationsArgs {
  doc_path: string;
}

export interface SaveAnnotationsArgs {
  doc_path: string;
  sidecar: Sidecar;
}

export interface GenerateReviewArgs {
  doc_path: string;
  review_markdown: string;
}

export interface GenerateReviewResult {
  review_path: string;
}

export interface ExportObsidianArgs {
  doc_path: string;
  review_markdown: string;
  vault_name: string;
}

export interface ExportObsidianResult {
  destination: string;
  method: 'rest' | 'filesystem';
}

export interface Settings {
  schema_version: 1;
  vaults: VaultConfig[];
  default_export_subfolder: string;
  theme: 'light' | 'dark' | 'system';
  export_on_save: boolean;
  rest_key_ref?: string; // reference to OS keychain entry, never the key itself
}

export interface VaultConfig {
  name: string;
  path: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface OpenFileRequestEvent {
  path: string;
}

export interface FileChangedEvent {
  path: string;
  external: boolean;
}

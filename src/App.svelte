<script lang="ts">
  // App shell — Revenant
  // Welcome screen renders when no file is open.
  // TabManager and Toolbar slots are reserved for WS-C components.
  // open_file_request event subscription wired in A3.

  let hasOpenFile = $state(false);

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    // TODO (A3): handle dropped files — emit to Rust open_file command
  }

  function handleOpenFile() {
    // TODO (A3): invoke open file dialog via Tauri dialog plugin
  }
</script>

<main class="app-shell">
  {#if !hasOpenFile}
    <!-- Welcome screen (C11): shown when no tab is open -->
    <div
      class="welcome-screen"
      role="region"
      aria-label="Welcome"
      ondragover={handleDragOver}
      ondrop={handleDrop}
    >
      <div class="welcome-content">
        <h1 class="welcome-title">Revenant</h1>
        <p class="welcome-subtitle">Markdown viewer &amp; review companion</p>

        <div class="drop-zone" aria-label="Drop zone for markdown files">
          <span class="drop-zone-icon">📄</span>
          <p>Drop a <code>.md</code> file here</p>
          <p class="drop-zone-or">or</p>
          <button class="open-btn" onclick={handleOpenFile} type="button">
            Open file…
          </button>
        </div>

        <!-- Recent files list — populated by WS-C tabs store -->
        <section class="recent-files" aria-label="Recent files">
          <h2>Recent files</h2>
          <p class="recent-empty">No recent files.</p>
        </section>
      </div>
    </div>
  {:else}
    <!-- Editor/preview shell — TabManager + Toolbar slotted by WS-C -->
    <div class="editor-shell">
      <!-- Toolbar slot: WS-C provides src/lib/Toolbar.svelte -->
      <div class="toolbar-slot" role="toolbar" aria-label="Toolbar">
        <!-- <Toolbar /> -->
      </div>

      <!-- Tab manager slot: WS-C provides src/lib/TabManager.svelte -->
      <div class="tabs-slot">
        <!-- <TabManager /> -->
      </div>

      <!-- Main content area -->
      <div class="content-area">
        <!-- EditorPane + PreviewPane — WS-C -->
      </div>

      <!-- Annotation drawer slot: WS-C provides src/lib/AnnotationDrawer.svelte -->
      <div class="drawer-slot">
        <!-- <AnnotationDrawer /> -->
      </div>
    </div>
  {/if}
</main>

<style>
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
      Roboto, sans-serif;
    background: #1a1a1a;
    color: #e0e0e0;
    height: 100vh;
    overflow: hidden;
  }

  .app-shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* --- Welcome screen --- */
  .welcome-screen {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }

  .welcome-content {
    max-width: 480px;
    width: 100%;
    text-align: center;
  }

  .welcome-title {
    font-size: 2.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #f0f0f0;
    margin-bottom: 0.5rem;
  }

  .welcome-subtitle {
    color: #888;
    margin-bottom: 2rem;
    font-size: 1rem;
  }

  .drop-zone {
    border: 2px dashed #444;
    border-radius: 12px;
    padding: 2.5rem 2rem;
    margin-bottom: 2rem;
    transition: border-color 0.2s ease;
    cursor: default;
  }

  .drop-zone:hover {
    border-color: #666;
  }

  .drop-zone-icon {
    font-size: 2.5rem;
    display: block;
    margin-bottom: 1rem;
  }

  .drop-zone p {
    color: #aaa;
    font-size: 0.95rem;
    margin-bottom: 0.5rem;
  }

  .drop-zone-or {
    color: #666;
    font-size: 0.85rem;
    margin: 0.75rem 0;
  }

  .open-btn {
    background: #3b82f6;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 0.6rem 1.4rem;
    font-size: 0.9rem;
    cursor: pointer;
    transition: background 0.15s ease;
    margin-top: 0.5rem;
  }

  .open-btn:hover {
    background: #2563eb;
  }

  .recent-files {
    text-align: left;
  }

  .recent-files h2 {
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #666;
    margin-bottom: 0.75rem;
  }

  .recent-empty {
    color: #555;
    font-size: 0.875rem;
  }

  /* --- Editor shell --- */
  .editor-shell {
    flex: 1;
    display: grid;
    grid-template-rows: auto auto 1fr;
    grid-template-columns: 1fr auto;
    height: 100vh;
  }

  .toolbar-slot {
    grid-column: 1 / -1;
    height: 40px;
    background: #252525;
    border-bottom: 1px solid #333;
  }

  .tabs-slot {
    grid-column: 1 / -1;
    height: 36px;
    background: #1e1e1e;
    border-bottom: 1px solid #333;
  }

  .content-area {
    overflow: hidden;
    background: #1a1a1a;
  }

  .drawer-slot {
    width: 320px;
    border-left: 1px solid #333;
    background: #1e1e1e;
    overflow-y: auto;
  }
</style>

// Generic operator UI shell. Renders whatever the registry projection API
// returns -- no adapter id, tool name, or capability string is special-cased
// here. Adding a new registered adapter changes only the API response, not
// this file.

const listEl = document.getElementById("adapter-list");
const detailEl = document.getElementById("adapter-detail");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function stateClass(state) {
  if (state === "running") return "state state-ok";
  if (state === "errored") return "state state-error";
  if (state === "stopped") return "state state-stopped";
  return "state state-pending";
}

function renderList(adapters) {
  if (!adapters.length) {
    listEl.innerHTML = '<p class="empty">No adapters registered.</p>';
    return;
  }
  listEl.innerHTML = `
    <ul class="adapters">
      ${adapters
        .map(
          (adapter) => `
        <li>
          <button class="adapter-row" data-id="${escapeHtml(adapter.id)}">
            <span class="name">${escapeHtml(adapter.displayName ?? adapter.id)}</span>
            <span class="${stateClass(adapter.state)}">${escapeHtml(adapter.state)}</span>
          </button>
        </li>`
        )
        .join("")}
    </ul>`;
  for (const button of listEl.querySelectorAll(".adapter-row")) {
    button.addEventListener("click", () => selectAdapter(button.dataset.id));
  }
}

function renderCapabilities(capabilities) {
  if (!capabilities?.length) return '<p class="empty">None declared.</p>';
  return `<ul class="tags">${capabilities.map((cap) => `<li>${escapeHtml(cap)}</li>`).join("")}</ul>`;
}

function renderTools(tools) {
  if (!tools?.length) return '<p class="empty">No tools discovered.</p>';
  return `<ul class="tags">${tools.map((tool) => `<li>${escapeHtml(tool.name ?? JSON.stringify(tool))}</li>`).join("")}</ul>`;
}

function renderHealth(health) {
  if (!health) return '<p class="empty">No health data.</p>';
  const parts = [`<p><strong>ok:</strong> ${health.ok}</p>`];
  if (health.error) parts.push(`<p class="error"><strong>error:</strong> ${escapeHtml(health.error)}</p>`);
  if (health.detail !== undefined) parts.push(`<pre>${escapeHtml(JSON.stringify(health.detail, null, 2))}</pre>`);
  return parts.join("");
}

function renderDetail(adapter) {
  detailEl.innerHTML = `
    <h2>${escapeHtml(adapter.displayName ?? adapter.id)}</h2>
    <dl class="identity">
      <dt>id</dt><dd>${escapeHtml(adapter.id)}</dd>
      <dt>version</dt><dd>${escapeHtml(adapter.version)}</dd>
      <dt>transport</dt><dd>${escapeHtml(adapter.transportKind)}</dd>
      <dt>state</dt><dd><span class="${stateClass(adapter.state)}">${escapeHtml(adapter.state)}</span></dd>
      ${adapter.error ? `<dt>error</dt><dd class="error">${escapeHtml(adapter.error)}</dd>` : ""}
      ${adapter.startedAt ? `<dt>started</dt><dd>${escapeHtml(adapter.startedAt)}</dd>` : ""}
      ${adapter.stoppedAt ? `<dt>stopped</dt><dd>${escapeHtml(adapter.stoppedAt)}</dd>` : ""}
    </dl>
    <h3>Capabilities</h3>
    ${renderCapabilities(adapter.capabilities)}
    <h3>Tools</h3>
    ${renderTools(adapter.tools)}
    <h3>Health</h3>
    ${renderHealth(adapter.health)}
  `;
}

async function selectAdapter(id) {
  detailEl.innerHTML = '<p class="empty">Loading&hellip;</p>';
  try {
    const response = await fetch(`/api/adapters/${encodeURIComponent(id)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      detailEl.innerHTML = `<p class="error">${escapeHtml(body.error ?? `request failed (${response.status})`)}</p>`;
      return;
    }
    renderDetail(await response.json());
  } catch (error) {
    detailEl.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

async function loadAdapters() {
  try {
    const response = await fetch("/api/adapters");
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    renderList(await response.json());
  } catch (error) {
    listEl.innerHTML = `<p class="error">Failed to load adapters: ${escapeHtml(error.message)}</p>`;
  }
}

loadAdapters();

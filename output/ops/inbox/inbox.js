const API_BASE =
  "https://focgeubdgfdglhsbgiqz.supabase.co/functions/v1/inbox-api";

const state = {
  token: sessionStorage.getItem("knok_inbox_token") || "",
  conversations: [],
  selectedId: null,
};

const $ = (selector) => document.querySelector(selector);
const auth = $("#auth");
const app = $("#app");

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = $("#token").value.trim();
  sessionStorage.setItem("knok_inbox_token", state.token);
  await openInbox();
});

$("#search").addEventListener("input", debounce(loadList, 250));
$("#status-filter").addEventListener("change", loadList);
$("#reply-form").addEventListener("submit", queueReply);
document.querySelectorAll("[data-status]").forEach((button) => {
  button.addEventListener("click", () => updateStatus(button.dataset.status));
});

if (state.token) openInbox();

async function openInbox() {
  try {
    await loadList();
    auth.classList.add("hidden");
    app.classList.remove("hidden");
    $("#auth-error").textContent = "";
  } catch (error) {
    sessionStorage.removeItem("knok_inbox_token");
    state.token = "";
    $("#auth-error").textContent = error.message;
  }
}

async function loadList() {
  const search = encodeURIComponent($("#search")?.value || "");
  const status = encodeURIComponent($("#status-filter")?.value || "");
  const data = await request(`?action=list&search=${search}&status=${status}`);
  state.conversations = data.conversations;
  renderSummary(data.summary, data.sending);
  renderList();
}

function renderSummary(summary, sending) {
  $("#needs-count").textContent = summary.needs_reply;
  $("#confirmed-count").textContent = summary.confirmed;
  $("#unread-count").textContent = summary.unread;
  $("#suppressed-count").textContent = summary.suppressed;
  const sendingState = $("#sending-state");
  sendingState.textContent = sending.reply_sending_enabled
    ? `Reply queue active · ${sending.per_minute_cap}/min`
    : `Reply queue paused${sending.paused_reason ? ` · ${sending.paused_reason}` : ""}`;
  sendingState.classList.toggle("active", sending.reply_sending_enabled);
}

function renderList() {
  const list = $("#conversation-list");
  list.replaceChildren();
  if (!state.conversations.length) {
    const empty = document.createElement("p");
    empty.className = "list-empty";
    empty.textContent = "No conversations match this filter.";
    list.append(empty);
    return;
  }
  for (const conversation of state.conversations) {
    const button = document.createElement("button");
    button.className = "conversation";
    if (conversation.id === state.selectedId) button.classList.add("selected");
    button.addEventListener("click", () => openThread(conversation.id));

    const row = document.createElement("span");
    row.className = "conversation-row";
    const name = document.createElement("strong");
    name.textContent = conversation.participant_name ||
      conversation.participant_email;
    const time = document.createElement("time");
    time.textContent = relativeTime(conversation.last_inbound_at);
    row.append(name, time);

    const preview = document.createElement("span");
    preview.className = "preview";
    preview.textContent = String(
      conversation.latest_text || conversation.subject || "No message preview",
    ).replace(/\s+/g, " ").slice(0, 100);

    const meta = document.createElement("span");
    meta.className = "conversation-meta";
    const status = document.createElement("span");
    status.className = `pill ${conversation.status}`;
    status.textContent = conversation.status.replace("_", " ");
    meta.append(status);
    if (conversation.unread_count > 0) {
      const unread = document.createElement("span");
      unread.className = "unread";
      unread.textContent = conversation.unread_count;
      meta.append(unread);
    }
    button.append(row, preview, meta);
    list.append(button);
  }
}

async function openThread(id) {
  state.selectedId = id;
  renderList();
  const data = await request(`?action=thread&id=${encodeURIComponent(id)}`);
  const conversation = data.conversation;
  $("#empty").classList.add("hidden");
  $("#thread").classList.remove("hidden");
  $("#person-name").textContent = conversation.participant_name ||
    conversation.participant_email;
  $("#person-meta").textContent =
    `${conversation.participant_email} · ${conversation.status.replace("_", " ")}`;

  const profile = $("#profile");
  profile.replaceChildren();
  [
    ["Role", conversation.role],
    ["Location", conversation.city],
    ["Experience", conversation.experience],
    ["Source", conversation.source],
  ].forEach(([label, value]) => {
    if (!value) return;
    const item = document.createElement("span");
    item.textContent = `${label}: ${value}`;
    profile.append(item);
  });
  if (conversation.linkedin_url) {
    const link = document.createElement("a");
    link.href = conversation.linkedin_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "LinkedIn profile";
    profile.append(link);
  }

  const messages = [
    ...data.inbound.map((message) => ({ ...message, direction: "inbound" })),
    ...data.outbound.map((message) => ({ ...message, direction: "outbound" })),
  ].sort((a, b) =>
    new Date(a.received_at || a.created_at) -
    new Date(b.received_at || b.created_at)
  );
  renderMessages(messages);
  $("#reply-body").disabled = conversation.is_suppressed ||
    conversation.status === "quarantined";
  $("#reply-form button").disabled = $("#reply-body").disabled;
  await loadList();
}

function renderMessages(messages) {
  const container = $("#messages");
  container.replaceChildren();
  for (const message of messages) {
    const article = document.createElement("article");
    article.className = `message ${message.direction}`;
    const head = document.createElement("div");
    head.className = "message-head";
    const label = document.createElement("strong");
    label.textContent = message.direction === "inbound"
      ? "Job seeker"
      : "Knok Jobs";
    const time = document.createElement("time");
    time.textContent = formatDate(message.received_at || message.created_at);
    head.append(label, time);
    const body = document.createElement("p");
    body.textContent = message.text_body || "(No plain-text body)";
    article.append(head, body);
    if (message.classification || message.status) {
      const foot = document.createElement("small");
      foot.textContent = message.classification
        ? `Classified: ${message.classification}`
        : `Delivery: ${message.status}`;
      article.append(foot);
    }
    container.append(article);
  }
  container.scrollTop = container.scrollHeight;
}

async function queueReply(event) {
  event.preventDefault();
  const textBody = $("#reply-body").value.trim();
  if (!textBody || !state.selectedId) return;
  $("#reply-state").textContent = "Queueing…";
  try {
    await request("", {
      method: "POST",
      body: JSON.stringify({
        action: "reply",
        conversation_id: state.selectedId,
        text_body: textBody,
        reply_key: crypto.randomUUID(),
        actor: "Knok operator",
      }),
    });
    $("#reply-body").value = "";
    $("#reply-state").textContent = "Reply queued safely.";
    await openThread(state.selectedId);
  } catch (error) {
    $("#reply-state").textContent = error.message;
  }
}

async function updateStatus(status) {
  if (!state.selectedId) return;
  if (
    status === "suppressed" &&
    !confirm("Suppress this contact and cancel every queued email?")
  ) return;
  await request("", {
    method: "POST",
    body: JSON.stringify({
      action: "status",
      conversation_id: state.selectedId,
      status,
      actor: "Knok operator",
    }),
  });
  await openThread(state.selectedId);
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.token}`,
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) throw new Error("Invalid operator token.");
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function relativeTime(value) {
  if (!value) return "";
  const minutes = Math.round((new Date(value) - new Date()) / 60000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

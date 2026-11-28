
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

let videos = [];
let tags = [];
let videoTagMap = {};
let currentCategory = "新着動画";

let isAdmin = false;
let isNamedUser = false;
let isVideoManager = false;
let canViewScormDemo = false;
let currentUser = null;

// SCORM体験版：非公開ストレージの場所とファイル名
const DEMO_BUCKET = "scorm-demo";
const DEMO_HTML = "scorm-demo.html";
const DEMO_VIDEOS = ["ja", "en", "pt"];
let scormDemoBlobUrl = null;

let realtimeChannel = null;
let isLoading = false;

const CATEGORIES = [
  "KYT",
  "フォークリフト",
  "テールゲートリフト",
  "安全講習"
];

function bindEvent(id, eventName, handler) {
  const element = $(id);
  if (!element) {
    console.error(`HTML要素が見つかりません: #${id}`);
    return;
  }
  element.addEventListener(eventName, handler);
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function showMessage(id, message, isError = true) {
  const element = $(id);
  if (!element) return;

  element.textContent = message;
  element.style.color = isError ? "#b13d3d" : "#287449";
}

function getVisibilityLabel(visibility) {
  return ({
    public: "全体公開",
    members: "ログインユーザー限定",
    admin: "管理者・動画管理者限定"
  })[visibility] || "全体公開";
}

function getYouTubeId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return parsed.pathname.split("/").filter(Boolean)[0] || null;
    }

    if ([
      "youtube.com",
      "m.youtube.com",
      "youtube-nocookie.com"
    ].includes(host)) {
      if (parsed.pathname === "/watch") {
        return parsed.searchParams.get("v");
      }

      const match = parsed.pathname.match(
        /^\/(embed|shorts|live)\/([a-zA-Z0-9_-]+)/
      );

      return match ? match[2] : null;
    }

    return null;
  } catch {
    return null;
  }
}

// --------------------------------------------------
// 動画サービスの判定（YouTube / Vimeo）
// 入力されたURLは検証して ID とハッシュだけを取り出し、
// 埋め込み先のURLは必ずこちらで組み立てる（入力をそのまま iframe に入れない）
// --------------------------------------------------

const VIMEO_HOSTS = ["vimeo.com", "player.vimeo.com"];
const VIMEO_ID_RE = /^[0-9]{1,15}$/;
const VIMEO_HASH_RE = /^[A-Za-z0-9]{1,64}$/;

// Vimeo公式の埋め込みコードが貼られた場合は、iframe の src だけを取り出す
function extractEmbedSrc(input) {
  const text = String(input || "").trim();
  if (!/^<iframe[\s>]/i.test(text) && !/^<div[\s>]/i.test(text)) return text;

  const match = text.match(/<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  return match ? match[1].replace(/&amp;/g, "&") : "";
}

function getVimeoInfo(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!VIMEO_HOSTS.includes(host)) return null;

    const parts = parsed.pathname.split("/").filter(Boolean);
    let id = null;
    let hash = parsed.searchParams.get("h");

    if (host === "player.vimeo.com") {
      // https://player.vimeo.com/video/{id}?h={hash}
      if (parts[0] === "video" && VIMEO_ID_RE.test(parts[1] || "")) id = parts[1];
    } else {
      // 対応する形：/{id}、/{id}/{hash}、/channels/xxx/{id}、/groups/xxx/videos/{id}、/showcase/xxx/video/{id}
      const videoIndex = parts.findIndex((part) => part === "video" || part === "videos");

      if (videoIndex >= 0) {
        id = VIMEO_ID_RE.test(parts[videoIndex + 1] || "") ? parts[videoIndex + 1] : null;
      } else if (parts[0] === "channels") {
        id = VIMEO_ID_RE.test(parts[2] || "") ? parts[2] : null;
      } else if (VIMEO_ID_RE.test(parts[0] || "")) {
        id = parts[0];
        const next = parts[1];
        if (!hash && next && VIMEO_HASH_RE.test(next) && !VIMEO_ID_RE.test(next)) hash = next;
      }
    }

    if (!id) return null;
    if (hash && !VIMEO_HASH_RE.test(hash)) return null;

    return { vimeoId: id, vimeoHash: hash || null };
  } catch {
    return null;
  }
}

// 入力（URL または Vimeo の埋め込みコード）を判定して、保存用の値にする
function parseVideoInput(input) {
  const url = extractEmbedSrc(input);
  if (!url) return null;

  const youtubeId = getYouTubeId(url);
  if (youtubeId && /^[A-Za-z0-9_-]{11}$/.test(youtubeId)) {
    return { video_provider: "youtube", youtube_id: youtubeId, vimeo_id: null, vimeo_hash: null };
  }

  const vimeo = getVimeoInfo(url);
  if (vimeo) {
    return { video_provider: "vimeo", youtube_id: null, vimeo_id: vimeo.vimeoId, vimeo_hash: vimeo.vimeoHash };
  }

  return null;
}

function isVimeo(video) {
  return video?.video_provider === "vimeo";
}

// 再生用の埋め込みURL（許可したドメインだけ・検証済みの値だけで組み立てる）
function getEmbedUrl(video) {
  if (isVimeo(video)) {
    if (!VIMEO_ID_RE.test(video.vimeo_id || "")) return "";
    const params = new URLSearchParams({ autoplay: "1", autopause: "0", dnt: "1", title: "0", byline: "0", portrait: "0" });
    if (video.vimeo_hash && VIMEO_HASH_RE.test(video.vimeo_hash)) params.set("h", video.vimeo_hash);
    return `https://player.vimeo.com/video/${video.vimeo_id}?${params.toString()}`;
  }

  if (!/^[A-Za-z0-9_-]{11}$/.test(video?.youtube_id || "")) return "";
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.youtube_id)}?autoplay=1`;
}

// 管理画面の編集欄に戻すためのURL
function getWatchUrl(video) {
  if (isVimeo(video)) {
    return `https://vimeo.com/${video.vimeo_id}${video.vimeo_hash ? `/${video.vimeo_hash}` : ""}`;
  }
  return `https://www.youtube.com/watch?v=${video.youtube_id}`;
}

function getVideoLabel(video) {
  return isVimeo(video) ? `Vimeo ${video.vimeo_id}` : `YouTube ${video.youtube_id || ""}`;
}

// サムネイル：YouTubeは画像URL、Vimeoは公式のoEmbedから取得（取得できなければ仮の画像）
const PLACEHOLDER_THUMB =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270"><rect width="480" height="270" fill="#1c3550"/><circle cx="240" cy="135" r="38" fill="#ffffff22"/><path d="M228 115v40l34-20z" fill="#fff"/></svg>');
const vimeoThumbCache = new Map();

function getThumbnailUrl(video) {
  if (isVimeo(video)) return vimeoThumbCache.get(video.vimeo_id) || PLACEHOLDER_THUMB;
  return `https://i.ytimg.com/vi/${encodeURIComponent(video.youtube_id)}/hqdefault.jpg`;
}

async function hydrateVimeoThumbnails(root = document) {
  const images = root.querySelectorAll("img[data-vimeo-thumb]");

  for (const img of images) {
    const id = img.dataset.vimeoThumb;
    const hash = img.dataset.vimeoHash || "";
    if (!VIMEO_ID_RE.test(id)) continue;

    if (vimeoThumbCache.has(id)) {
      img.src = vimeoThumbCache.get(id);
      continue;
    }

    try {
      const target = `https://vimeo.com/${id}${hash && VIMEO_HASH_RE.test(hash) ? `/${hash}` : ""}`;
      const response = await fetch(`https://vimeo.com/api/oembed.json?width=640&url=${encodeURIComponent(target)}`);
      if (!response.ok) continue;

      const data = await response.json();
      const thumb = new URL(data.thumbnail_url);

      // Vimeo の画像配信ドメイン以外は使わない
      if (thumb.protocol === "https:" && /(^|\.)vimeocdn\.com$/.test(thumb.hostname)) {
        vimeoThumbCache.set(id, thumb.href);
        document.querySelectorAll(`img[data-vimeo-thumb="${id}"]`).forEach((el) => { el.src = thumb.href; });
      }
    } catch {
      // 取得できない場合は仮の画像のまま
    }
  }
}

function thumbnailAttrs(video) {
  return isVimeo(video)
    ? ` data-vimeo-thumb="${escapeHTML(video.vimeo_id)}" data-vimeo-hash="${escapeHTML(video.vimeo_hash || "")}"`
    : "";
}

async function makeInternalEmail(username) {
  const bytes = new TextEncoder().encode(username);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `u-${hash.slice(0, 48)}@named-login.invalid`;
}

function canManageVideos() {
  return isAdmin || isVideoManager;
}

// --------------------------------------------------
// 動画・タグの取得
// --------------------------------------------------

async function loadVideos() {
  if (isLoading) return;
  isLoading = true;

  const grid = $("videoGrid");

  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("動画取得エラー:", error);
    if (grid) {
      grid.innerHTML =
        '<div class="empty-state">動画を読み込めませんでした。</div>';
    }
    isLoading = false;
    return;
  }

  videos = data || [];
  isLoading = false;

  await loadVideoTagRelations();
  renderVideos();
  renderAdminVideoPreview();
  renderAdminVideoList();
}

async function loadTags() {
  const { data, error } = await supabase
    .from("video_tags_master")
    .select("id, name")
    .order("name", { ascending: true });

  if (error) {
    console.error("タグ取得エラー:", error);
    tags = [];
  } else {
    tags = data || [];
  }

  renderTagCheckboxes();
  renderTagManagementList();
  renderVideos();
  renderAdminVideoList();
}

async function loadVideoTagRelations() {
  videoTagMap = {};

  const { data, error } = await supabase
    .from("video_tag_relations")
    .select("video_id, tag_id");

  if (error) {
    console.error("動画タグ取得エラー:", error);
    return;
  }

  (data || []).forEach((relation) => {
    const videoId = String(relation.video_id);

    if (!videoTagMap[videoId]) {
      videoTagMap[videoId] = [];
    }

    videoTagMap[videoId].push(Number(relation.tag_id));
  });
}

// --------------------------------------------------
// 動画の絞り込み・表示
// --------------------------------------------------

function getFilteredVideos() {
  const searchInput = $("searchInput");
  const keyword = searchInput
    ? searchInput.value.trim().toLowerCase()
    : "";

  const targetVideos = currentCategory === "新着動画"
    ? videos.slice(0, 5)
    : videos.filter(
        (video) => video.category === currentCategory
      );

  return targetVideos.filter((video) => {
    const videoTags = (videoTagMap[String(video.id)] || [])
      .map((id) => tags.find((tag) => Number(tag.id) === Number(id))?.name || "");

    const searchable = [
      video.title,
      video.description,
      video.category,
      ...videoTags
    ].join(" ").toLowerCase();

    return searchable.includes(keyword);
  });
}

function renderVideos() {
  const grid = $("videoGrid");
  if (!grid) return;

  const filtered = getFilteredVideos();

  if ($("currentCategory")) {
    $("currentCategory").textContent = currentCategory;
  }

  if ($("videoCount")) {
    $("videoCount").textContent = `${filtered.length}本`;
  }

  if (filtered.length === 0) {
    grid.innerHTML =
      '<div class="empty-state">該当する動画はありません。</div>';
    return;
  }

  grid.innerHTML = filtered.map((video) => {
    const id = escapeHTML(video.id);
    const title = escapeHTML(video.title);
    const description = escapeHTML(video.description || "");
    const category = escapeHTML(video.category);

    const thumbnail = getThumbnailUrl(video);

    const videoTags = (videoTagMap[String(video.id)] || [])
      .map((tagId) => tags.find((tag) => Number(tag.id) === Number(tagId)))
      .filter(Boolean);

    return `
      <article class="video-card">
        <div class="video-thumbnail"
             role="button"
             tabindex="0"
             data-play="${id}"
             aria-label="${title}を再生">
          <img src="${escapeHTML(thumbnail)}" alt="${title}" loading="lazy"${thumbnailAttrs(video)}>
          <span class="play-button">▶</span>
        </div>

        <div class="video-info">
          <span class="video-category">${category}</span>

          ${canManageVideos() ? `
            <span class="video-visibility">
              ${escapeHTML(getVisibilityLabel(video.visibility))}
            </span>
          ` : ""}

          <h4>${title}</h4>
          <p>${description || "説明はありません。"}</p>

          <div class="video-tag-display">
            ${videoTags.map((tag) => `
              <span class="video-tag">${escapeHTML(tag.name)}</span>
            `).join("")}
          </div>
        </div>

        ${canManageVideos() ? `
          <div class="video-card-actions">
            <button class="small-button" data-edit="${id}">編集</button>
            <button class="small-button delete" data-delete="${id}">削除</button>
          </div>
        ` : ""}
      </article>
    `;
  }).join("");

  hydrateVimeoThumbnails(grid);
}

// --------------------------------------------------
// 管理画面
// --------------------------------------------------

function updateAdminView() {
  const canManage = canManageVideos();

  if ($("adminPanel")) {
    $("adminPanel").classList.toggle("hidden", !canManage);
  }

  if ($("adminLoginBtn")) {
    $("adminLoginBtn").classList.toggle("hidden", !!currentUser);
  }

  if ($("adminLogoutBtn")) {
    $("adminLogoutBtn").classList.toggle("hidden", !currentUser);
  }

  if ($("managementRoleLabel")) {
    $("managementRoleLabel").textContent = isAdmin
      ? "管理者"
      : isVideoManager
        ? "動画管理権限"
        : "";
  }

  if ($("namedUserManagement")) {
    $("namedUserManagement").classList.toggle("hidden", !isAdmin);
  }

  renderVideos();
}

function resetVideoForm() {
  if ($("videoForm")) $("videoForm").reset();
  if ($("editVideoId")) $("editVideoId").value = "";
  if ($("videoVisibility")) $("videoVisibility").value = "public";
  if ($("saveVideoBtn")) $("saveVideoBtn").textContent = "動画を登録";
  if ($("cancelEditBtn")) $("cancelEditBtn").classList.add("hidden");

  renderTagCheckboxes([]);
  showMessage("formMessage", "", false);
}

function renderTagCheckboxes(selectedIds = null) {
  const container = $("videoTagCheckboxes");
  if (!container) return;

  // 指定がなければ、いま選んでいるタグをそのまま残す（タグの追加・更新で選択が消えないように）
  const selected = selectedIds || getSelectedFormTagIds();

  if (!tags.length) {
    container.innerHTML =
      '<span class="muted-text">まだタグはありません。下の欄から作成できます。</span>';
    return;
  }

  container.innerHTML = tags.map((tag) => `
    <label class="tag-checkbox">
      <input
        type="checkbox"
        name="videoTag"
        value="${escapeHTML(tag.id)}"
        ${selected.some((id) => Number(id) === Number(tag.id)) ? "checked" : ""}
      >
      <span>${escapeHTML(tag.name)}</span>
    </label>
  `).join("");
}

// 動画の登録画面で、新しいタグを作ってそのまま選択する
async function createTagInline() {
  if (!canManageVideos()) return;

  const input = $("inlineTagName");
  const name = input.value.trim();

  if (!name) {
    showMessage("inlineTagMessage", "タグ名を入力してください。");
    return;
  }

  if (name.length > 40) {
    showMessage("inlineTagMessage", "タグ名は40文字以内にしてください。");
    return;
  }

  const selected = getSelectedFormTagIds();
  const existing = tags.find((tag) => tag.name === name);

  if (existing) {
    renderTagCheckboxes([...selected, existing.id]);
    input.value = "";
    showMessage("inlineTagMessage", `「${name}」は登録済みのタグなので、選択しました。`, false);
    return;
  }

  const button = $("inlineTagAddBtn");
  button.disabled = true;

  try {
    const { data, error } = await supabase
      .from("video_tags_master")
      .insert({ name })
      .select("id, name")
      .single();

    if (error) {
      console.error("タグ作成エラー:", error);
      showMessage(
        "inlineTagMessage",
        error.code === "23505" ? "同じ名前のタグがすでにあります。" : "タグを作成できませんでした。"
      );
      return;
    }

    if (!tags.some((tag) => Number(tag.id) === Number(data.id))) {
      tags = [...tags, data].sort((a, b) => a.name.localeCompare(b.name, "ja"));
    }

    renderTagCheckboxes([...selected, data.id]);
    renderTagManagementList();
    input.value = "";
    showMessage("inlineTagMessage", `タグ「${name}」を作成して選択しました。`, false);

  } finally {
    button.disabled = false;
  }
}

function getSelectedFormTagIds() {
  return Array.from(
    document.querySelectorAll('#videoTagCheckboxes input[name="videoTag"]:checked')
  ).map((input) => Number(input.value));
}

// --------------------------------------------------
// 動画再生
// --------------------------------------------------

function openPlayer(video) {
  const dialog = $("playerDialog");
  const player = $("youtubePlayer");

  if (!dialog || !player) return;

  if ($("playerTitle")) {
    $("playerTitle").textContent = video.title;
  }

  if ($("playerDescription")) {
    $("playerDescription").textContent = video.description || "";
  }

  const embedUrl = getEmbedUrl(video);
  if (!embedUrl) {
    alert("この動画は再生できません。登録内容を確認してください。");
    return;
  }

  player.title = isVimeo(video) ? "Vimeo動画プレーヤー" : "YouTube動画プレーヤー";
  player.src = embedUrl;

  dialog.showModal();
}

function closePlayer() {
  if ($("youtubePlayer")) $("youtubePlayer").src = "";

  if ($("playerDialog")?.open) {
    $("playerDialog").close();
  }
}

// --------------------------------------------------
// 動画とタグの保存
// --------------------------------------------------

async function saveVideoTags(videoId, tagIds) {
  const { error: deleteError } = await supabase
    .from("video_tag_relations")
    .delete()
    .eq("video_id", videoId);

  if (deleteError) {
    console.error("動画タグ削除エラー:", deleteError);
    return deleteError;
  }

  if (!tagIds.length) return null;

  const rows = tagIds.map((tagId) => ({
    video_id: videoId,
    tag_id: tagId
  }));

  const { error: insertError } = await supabase
    .from("video_tag_relations")
    .insert(rows);

  if (insertError) {
    console.error("動画タグ登録エラー:", insertError);
    return insertError;
  }

  return null;
}

async function handleVideoSubmit(event) {
  event.preventDefault();

  if (!canManageVideos()) {
    showMessage("formMessage", "動画管理権限が必要です。");
    return;
  }

  const url = $("videoUrl").value.trim();
  const youtubeId = getYouTubeId(url);

  if (!youtubeId) {
    showMessage("formMessage", "有効なYouTube URLを入力してください。");
    return;
  }

  const title = $("videoTitle").value.trim();
  const description = $("videoDescription").value.trim();
  const category = $("videoCategory").value;
  const visibility = $("videoVisibility").value;
  const editId = $("editVideoId").value;
  const selectedTagIds = getSelectedFormTagIds();

  if (!title) {
    showMessage("formMessage", "動画タイトルを入力してください。");
    return;
  }

  if (!["public", "members", "admin"].includes(visibility)) {
    showMessage("formMessage", "公開範囲を選択してください。");
    return;
  }

  const button = $("saveVideoBtn");
  button.disabled = true;

  const payload = {
    youtube_id: youtubeId,
    title,
    description,
    category,
    visibility
  };

  try {
    let videoId = editId;

    if (editId) {
      const { error } = await supabase
        .from("videos")
        .update(payload)
        .eq("id", editId);

      if (error) throw error;

    } else {
      const { data, error } = await supabase
        .from("videos")
        .insert(payload)
        .select("id")
        .single();

      if (error) throw error;
      videoId = data.id;
    }

    const tagError = await saveVideoTags(videoId, selectedTagIds);

    if (tagError) {
      showMessage(
        "formMessage",
        "動画は保存されましたが、タグの保存に失敗しました。"
      );
      await loadVideos();
      return;
    }

    resetVideoForm();
    showMessage("formMessage", "動画を保存しました。", false);

    await loadVideos();

  } catch (error) {
    console.error("動画保存エラー:", error);
    showMessage(
      "formMessage",
      "保存に失敗しました。権限設定や入力内容を確認してください。"
    );
  } finally {
    button.disabled = false;
  }
}

function editVideo(id) {
  if (!canManageVideos()) return;

  const video = videos.find(
    (item) => String(item.id) === String(id)
  );

  if (!video) return;

  $("editVideoId").value = video.id;
  $("videoUrl").value = getWatchUrl(video);
  $("videoTitle").value = video.title;
  $("videoDescription").value = video.description || "";
  $("videoCategory").value = video.category;
  $("videoVisibility").value = video.visibility || "public";

  renderTagCheckboxes(videoTagMap[String(video.id)] || []);

  $("saveVideoBtn").textContent = "変更を保存";
  $("cancelEditBtn").classList.remove("hidden");
  $("adminPanel").scrollIntoView({ behavior: "smooth" });
}

async function deleteVideo(id) {
  if (!canManageVideos()) return;

  const video = videos.find(
    (item) => String(item.id) === String(id)
  );

  if (!video) return;
  if (!confirm(`「${video.title}」を削除しますか？`)) return;

  const { error } = await supabase
    .from("videos")
    .delete()
    .eq("id", id);

  if (error) {
    console.error(error);
    alert("削除できませんでした。動画管理権限を確認してください。");
    return;
  }

  await loadVideos();
}

// --------------------------------------------------
// 管理画面：プレビュー表示
// --------------------------------------------------

function renderAdminVideoPreview() {
  const container = $("adminVideoPreview");
  if (!container) return;

  if (!canManageVideos()) return;

  if (!videos.length) {
    container.innerHTML =
      '<p class="muted-text">登録されている動画はありません。</p>';
    return;
  }

  container.innerHTML = `
    <div class="video-grid">
      ${videos.map((video) => {
        const id = escapeHTML(video.id);
        const title = escapeHTML(video.title);
        const thumbnail = getThumbnailUrl(video);

        return `
          <article class="video-card">
            <div class="video-thumbnail"
                 role="button"
                 tabindex="0"
                 data-admin-play="${id}">
              <img src="${escapeHTML(thumbnail)}" alt="${title}" loading="lazy"${thumbnailAttrs(video)}>
              <span class="play-button">▶</span>
            </div>
            <div class="video-info">
              <span class="video-category">${escapeHTML(video.category)}</span>
              <span class="video-visibility">
                ${escapeHTML(getVisibilityLabel(video.visibility))}
              </span>
              <h4>${title}</h4>
            </div>
            <div class="video-card-actions">
              <button class="small-button" data-admin-edit="${id}">編集</button>
              <button class="small-button delete" data-admin-delete="${id}">削除</button>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;

  hydrateVimeoThumbnails(container);
}

// --------------------------------------------------
// 管理画面：Excel風の表形式リスト
// --------------------------------------------------

function renderAdminVideoList() {
  const container = $("adminVideoList");
  if (!container || !canManageVideos()) return;

  if (!videos.length) {
    container.innerHTML =
      '<p class="muted-text">登録されている動画はありません。</p>';
    return;
  }

  container.innerHTML = `
    <div class="video-table-scroll">
      <table class="video-management-table">
        <thead>
          <tr>
            <th class="video-name-column">動画名</th>
            <th>カテゴリ</th>
            <th>公開範囲</th>
            <th class="description-column">説明文</th>
            <th class="tags-column">タグ</th>
            <th>保存状態</th>
            <th>操作</th>
          </tr>
        </thead>

        <tbody>
          ${videos.map((video) => {
            const id = escapeHTML(video.id);
            const selectedTagIds = videoTagMap[String(video.id)] || [];

            return `
              <tr data-row-id="${id}">
                <td class="video-name-column">
                  <div class="table-video-title">
                    <strong>${escapeHTML(video.title)}</strong>
                    <span>${escapeHTML(getVideoLabel(video))}</span>
                  </div>
                </td>

                <td>
                  <select
                    class="table-select"
                    data-auto-field="category"
                    data-video-id="${id}"
                    aria-label="${escapeHTML(video.title)}のカテゴリ"
                  >
                    ${CATEGORIES.map((category) => `
                      <option
                        value="${escapeHTML(category)}"
                        ${video.category === category ? "selected" : ""}
                      >${escapeHTML(category)}</option>
                    `).join("")}
                  </select>
                </td>

                <td>
                  <select
                    class="table-select"
                    data-auto-field="visibility"
                    data-video-id="${id}"
                    aria-label="${escapeHTML(video.title)}の公開範囲"
                  >
                    <option value="public" ${video.visibility === "public" ? "selected" : ""}>全体公開</option>
                    <option value="members" ${video.visibility === "members" ? "selected" : ""}>ログインユーザー限定</option>
                    <option value="admin" ${video.visibility === "admin" ? "selected" : ""}>管理者・動画管理者限定</option>
                  </select>
                </td>

                <td class="description-column">
                  <textarea
                    class="table-description"
                    data-auto-field="description"
                    data-video-id="${id}"
                    rows="2"
                    aria-label="${escapeHTML(video.title)}の説明文"
                    placeholder="説明文を入力"
                  >${escapeHTML(video.description || "")}</textarea>
                </td>

                <td class="tags-column">
                  <div class="table-tag-list">
                    ${tags.length ? tags.map((tag) => `
                      <label class="table-tag-option">
                        <input
                          type="checkbox"
                          data-auto-tag="${escapeHTML(tag.id)}"
                          data-video-id="${id}"
                          ${selectedTagIds.some((tagId) => Number(tagId) === Number(tag.id)) ? "checked" : ""}
                        >
                        <span>${escapeHTML(tag.name)}</span>
                      </label>
                    `).join("") : '<span class="muted-text">タグなし</span>'}
                  </div>
                </td>

                <td>
                  <span
                    class="auto-save-status"
                    data-save-status="${id}"
                  >保存済み</span>
                </td>

                <td class="table-actions">
                  <button
                    type="button"
                    class="small-button"
                    data-edit="${id}"
                  >詳細編集</button>

                  <button
                    type="button"
                    class="small-button delete"
                    data-delete="${id}"
                  >削除</button>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function setRowSaveStatus(videoId, message, state = "saved") {
  const status = document.querySelector(
    `[data-save-status="${CSS.escape(String(videoId))}"]`
  );

  if (!status) return;

  status.textContent = message;
  status.dataset.state = state;
}

async function autoSaveVideoField(videoId, field, value) {
  if (!canManageVideos()) return;

  if (!["category", "visibility", "description"].includes(field)) {
    return;
  }

  if (
    field === "visibility" &&
    !["public", "members", "admin"].includes(value)
  ) {
    return;
  }

  if (
    field === "category" &&
    !CATEGORIES.includes(value)
  ) {
    return;
  }

  setRowSaveStatus(videoId, "保存中...", "saving");

  const { error } = await supabase
    .from("videos")
    .update({ [field]: value })
    .eq("id", videoId);

  if (error) {
    console.error("自動保存エラー:", error);
    setRowSaveStatus(videoId, "保存失敗・再変更してください", "error");
    return;
  }

  const video = videos.find(
    (item) => String(item.id) === String(videoId)
  );

  if (video) {
    video[field] = value;
  }

  setRowSaveStatus(videoId, "保存しました", "saved");

  renderVideos();
  renderAdminVideoPreview();
}

async function autoSaveVideoTags(videoId, tagIds) {
  if (!canManageVideos()) return;

  setRowSaveStatus(videoId, "タグ保存中...", "saving");

  const error = await saveVideoTags(videoId, tagIds);

  if (error) {
    setRowSaveStatus(videoId, "タグ保存失敗・再変更してください", "error");
    return;
  }

  videoTagMap[String(videoId)] = tagIds;

  setRowSaveStatus(videoId, "保存しました", "saved");

  renderVideos();
  renderAdminVideoPreview();
}

// --------------------------------------------------
// タグ管理
// --------------------------------------------------

function renderTagManagementList() {
  const container = $("tagManagementList");
  if (!container || !canManageVideos()) return;

  if (!tags.length) {
    container.innerHTML =
      '<p class="muted-text">登録されているタグはありません。</p>';
    return;
  }

  container.innerHTML = tags.map((tag) => `
    <div class="tag-management-item">
      <span>${escapeHTML(tag.name)}</span>
      <div>
        <button
          type="button"
          class="small-button"
          data-edit-tag="${escapeHTML(tag.id)}"
        >名前変更</button>
        <button
          type="button"
          class="small-button delete"
          data-delete-tag="${escapeHTML(tag.id)}"
        >削除</button>
      </div>
    </div>
  `).join("");
}

async function addTag(event) {
  event.preventDefault();

  if (!canManageVideos()) return;

  const name = $("newTagName").value.trim();

  if (!name) {
    showMessage("tagMessage", "タグ名を入力してください。");
    return;
  }

  if (name.length > 40) {
    showMessage("tagMessage", "タグ名は40文字以内にしてください。");
    return;
  }

  const { error } = await supabase
    .from("video_tags_master")
    .insert({ name });

  if (error) {
    console.error("タグ追加エラー:", error);
    showMessage(
      "tagMessage",
      error.code === "23505"
        ? "同じ名前のタグがすでにあります。"
        : "タグを追加できませんでした。"
    );
    return;
  }

  $("tagForm").reset();
  showMessage("tagMessage", "タグを追加しました。", false);

  await loadTags();
}

async function editTag(id) {
  if (!canManageVideos()) return;

  const tag = tags.find(
    (item) => String(item.id) === String(id)
  );

  if (!tag) return;

  const newName = prompt("新しいタグ名を入力してください。", tag.name);

  if (newName === null) return;

  const name = newName.trim();

  if (!name || name.length > 40) {
    alert("タグ名は1〜40文字で入力してください。");
    return;
  }

  const { error } = await supabase
    .from("video_tags_master")
    .update({ name })
    .eq("id", id);

  if (error) {
    console.error("タグ変更エラー:", error);
    alert("タグ名を変更できませんでした。");
    return;
  }

  await loadTags();
}

async function deleteTag(id) {
  if (!canManageVideos()) return;

  const tag = tags.find(
    (item) => String(item.id) === String(id)
  );

  if (!tag) return;

  if (!confirm(`タグ「${tag.name}」を削除しますか？\nこのタグの動画との紐付けも解除されます。`)) {
    return;
  }

  const { error } = await supabase
    .from("video_tags_master")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("タグ削除エラー:", error);
    alert("タグを削除できませんでした。");
    return;
  }

  await loadTags();
  await loadVideos();
}

// --------------------------------------------------
// ログイン
// --------------------------------------------------

// 管理者（メールアドレス）も発行ユーザー（ユーザーID）も同じ入力欄でログインする
async function login(event) {
  event.preventDefault();
  showMessage("loginMessage", "");

  const loginId = $("loginId").value.trim();
  const password = $("loginPassword").value;

  if (!loginId) {
    showMessage("loginMessage", "ログインIDを入力してください。");
    return;
  }

  try {
    const internalEmail = await makeInternalEmail(loginId);
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginId);

    // メールアドレスの形なら管理者として先に試し、だめならユーザーIDとして試す
    const candidates = looksLikeEmail ? [loginId, internalEmail] : [internalEmail];

    let lastError = null;
    for (const email of candidates) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (!error) {
        $("loginDialog").close();
        $("loginForm").reset();
        return;
      }
      lastError = error;
    }

    console.error("ログインエラー:", lastError);
    showMessage("loginMessage", "ログインできませんでした。ログインIDとパスワードを確認してください。");

  } catch (error) {
    console.error(error);
    showMessage("loginMessage", "ログイン処理に失敗しました。もう一度お試しください。");
  }
}

async function logout() {
  const { error } = await supabase.auth.signOut();

  if (error) {
    console.error(error);
    alert("ログアウトできませんでした。");
    return;
  }

  resetVideoForm();
}

// --------------------------------------------------
// ユーザー権限の確認
// --------------------------------------------------

async function checkUserRole(user) {
  currentUser = user || null;
  isAdmin = false;
  isNamedUser = false;
  isVideoManager = false;
  canViewScormDemo = false;

  if (user) {
    const { data: adminData, error: adminError } = await supabase
      .from("video_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      console.error("管理者確認エラー:", adminError);
    }

    isAdmin = !!adminData;

    const { data: namedData, error: namedError } =
      await supabase.rpc("is_named_user");

    if (namedError) {
      console.error("ユーザー権限確認エラー:", namedError);
    }

    isNamedUser = namedData === true;

    const { data: managerData, error: managerError } =
      await supabase.rpc("is_video_manager");

    if (managerError) {
      console.error("動画管理権限確認エラー:", managerError);
    }

    isVideoManager = managerData === true;

    const { data: demoData, error: demoError } =
      await supabase.rpc("can_view_scorm_demo");

    if (demoError) {
      console.error("体験版の権限確認エラー:", demoError);
    }

    canViewScormDemo = demoData === true;
  }

  updateAdminView();
  updateScormDemoView();

  await loadTags();
  await loadVideos();

  if (isAdmin) {
    await loadNamedUsers();
    await loadScormDemoFiles();
  } else if ($("namedUserList")) {
    $("namedUserList").innerHTML = "";
  }
}

// --------------------------------------------------
// ネームドユーザー発行・権限変更
// --------------------------------------------------

async function createNamedUser(event) {
  event.preventDefault();

  if (!isAdmin) {
    showMessage("namedUserMessage", "管理者ログインが必要です。");
    return;
  }

  const username = $("namedUsername").value.trim();
  const password = $("namedPassword").value;

  if (!username || username.length > 64) {
    showMessage("namedUserMessage", "ログインIDは1〜64文字で入力してください。");
    return;
  }

  if (/[\u0000-\u001f\u007f]/.test(username)) {
    showMessage("namedUserMessage", "ログインIDに使用できない文字が含まれています。");
    return;
  }

  if (password.length < 8 || password.length > 72) {
    showMessage("namedUserMessage", "パスワードは8〜72文字で設定してください。");
    return;
  }

  const button = $("createNamedUserBtn");
  button.disabled = true;
  button.textContent = "発行中...";

  try {
    const { data, error } = await supabase.functions.invoke(
      "create-named-user",
      { body: { username, password } }
    );

    if (error) {
      console.error("ユーザー発行エラー:", error);
      throw new Error(
        "ユーザーを発行できませんでした。IDの重複や関数の設定を確認してください。"
      );
    }

    if (!data || !data.success) {
      throw new Error(data?.error || "ユーザーを発行できませんでした。");
    }

    $("createNamedUserForm").reset();

    showMessage(
      "namedUserMessage",
      `「${username}」を発行しました。`,
      false
    );

    await loadNamedUsers();

  } catch (error) {
    console.error(error);
    showMessage(
      "namedUserMessage",
      error.message || "ユーザー発行に失敗しました。"
    );

  } finally {
    button.disabled = false;
    button.textContent = "ユーザーを作成";
  }
}

async function loadNamedUsers() {
  if (!isAdmin) return;

  const list = $("namedUserList");
  if (!list) return;

  const { data, error } = await supabase
    .from("named_users")
    .select("username, is_active, created_at, video_management_enabled, scorm_demo_enabled")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("ユーザー一覧取得エラー:", error);
    list.innerHTML =
      '<p class="empty-state">ユーザー一覧を取得できませんでした。</p>';
    return;
  }

  if (!data || data.length === 0) {
    list.innerHTML =
      '<p class="empty-state">発行済みユーザーはいません。</p>';
    return;
  }

  list.innerHTML = data.map((user) => `
    <div class="named-user-item">
      <div class="named-user-info">
        <span class="named-user-name">
          ${escapeHTML(user.username)}
        </span>
        <span class="named-user-status ${user.is_active ? "" : "inactive"}">
          ${user.is_active ? "利用中" : "利用停止中"}
        </span>
      </div>

      <div class="permission-toggles">
        <label class="permission-toggle">
          <input
            type="checkbox"
            data-manager-user="${escapeHTML(user.username)}"
            ${user.video_management_enabled ? "checked" : ""}
            ${!user.is_active ? "disabled" : ""}
          >
          <span>動画管理権限</span>
        </label>

        <label class="permission-toggle">
          <input
            type="checkbox"
            data-demo-user="${escapeHTML(user.username)}"
            ${user.scorm_demo_enabled ? "checked" : ""}
            ${!user.is_active ? "disabled" : ""}
          >
          <span>SCORM体験版</span>
        </label>
      </div>
    </div>
  `).join("");
}

async function changeUserPermission(username, enabled) {
  if (!isAdmin) return;

  const { error } = await supabase
    .from("named_users")
    .update({ video_management_enabled: enabled })
    .eq("username", username);

  if (error) {
    console.error("権限変更エラー:", error);
    alert("権限を変更できませんでした。");
    await loadNamedUsers();
    return;
  }

  showMessage(
    "namedUserMessage",
    `${username} の動画管理権限を${enabled ? "付与" : "解除"}しました。`,
    false
  );
}

async function changeScormDemoPermission(username, enabled) {
  if (!isAdmin) return;

  const { error } = await supabase
    .from("named_users")
    .update({ scorm_demo_enabled: enabled })
    .eq("username", username);

  if (error) {
    console.error("体験版の許可変更エラー:", error);
    alert("SCORM体験版の閲覧許可を変更できませんでした。");
    await loadNamedUsers();
    return;
  }

  showMessage(
    "namedUserMessage",
    `${username} のSCORM体験版の閲覧を${enabled ? "許可" : "停止"}しました。`,
    false
  );
}

// --------------------------------------------------
// SCORM体験版
// --------------------------------------------------

function updateScormDemoView() {
  $("scormDemoSection")?.classList.toggle("hidden", !canViewScormDemo);
  $("scormDemoManagement")?.classList.toggle("hidden", !isAdmin);

  if (!canViewScormDemo && $("scormDemoDialog")?.open) {
    closeScormDemo();
  }
}

async function openScormDemo() {
  if (!canViewScormDemo) return;

  const button = $("openScormDemoBtn");
  button.disabled = true;
  button.textContent = "読み込み中...";
  showMessage("scormDemoMessage", "", false);

  try {
    const { data: file, error } = await supabase.storage
      .from(DEMO_BUCKET)
      .download(DEMO_HTML);

    if (error || !file) {
      throw new Error("体験版を読み込めませんでした。管理者がファイルを登録しているか確認してください。");
    }

    let html = await file.text();

    // 動画は署名付きURL（1時間有効）で渡す
    const videoUrls = {};
    const { data: signed } = await supabase.storage
      .from(DEMO_BUCKET)
      .createSignedUrls(DEMO_VIDEOS.map((lang) => `videos/${lang}.mp4`), 3600);

    (signed || []).forEach((item, index) => {
      if (item?.signedUrl) videoUrls[DEMO_VIDEOS[index]] = item.signedUrl;
    });

    const inject =
      `<script>window.__DEMO_VIDEOS=${JSON.stringify(videoUrls).replace(/</g, "\\u003c")};<\/script>`;
    html = html.replace(/<head>/i, `<head>${inject}`);

    if (scormDemoBlobUrl) URL.revokeObjectURL(scormDemoBlobUrl);
    scormDemoBlobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));

    $("scormDemoFrame").src = scormDemoBlobUrl;
    $("scormDemoDialog").showModal();

  } catch (error) {
    console.error(error);
    showMessage("scormDemoMessage", error.message || "体験版を開けませんでした。");

  } finally {
    button.disabled = false;
    button.textContent = "体験版をひらく";
  }
}

function closeScormDemo() {
  const dialog = $("scormDemoDialog");
  if (dialog?.open) dialog.close();

  if ($("scormDemoFrame")) $("scormDemoFrame").src = "about:blank";

  if (scormDemoBlobUrl) {
    URL.revokeObjectURL(scormDemoBlobUrl);
    scormDemoBlobUrl = null;
  }
}

function demoPathFor(fileName) {
  const name = fileName.toLowerCase();
  if (name.endsWith(".html")) return DEMO_HTML;

  const match = /^(ja|en|pt)\.mp4$/.exec(name);
  return match ? `videos/${match[1]}.mp4` : null;
}

async function loadScormDemoFiles() {
  if (!isAdmin) return;

  const list = $("scormDemoFileList");
  if (!list) return;

  const rows = [];
  const [{ data: rootFiles }, { data: videoFiles }] = await Promise.all([
    supabase.storage.from(DEMO_BUCKET).list(""),
    supabase.storage.from(DEMO_BUCKET).list("videos")
  ]);

  const found = {};
  (rootFiles || []).forEach((f) => { if (f.id) found[f.name] = f; });
  (videoFiles || []).forEach((f) => { found[`videos/${f.name}`] = f; });

  [DEMO_HTML, ...DEMO_VIDEOS.map((lang) => `videos/${lang}.mp4`)].forEach((path) => {
    const f = found[path];
    const size = f?.metadata?.size ? `${(f.metadata.size / 1048576).toFixed(1)} MB` : "";
    const date = f?.updated_at ? new Date(f.updated_at).toLocaleString("ja-JP") : "";

    rows.push(`
      <div class="scorm-demo-file ${f ? "" : "missing"}">
        <span class="scorm-demo-file-name">${escapeHTML(path)}</span>
        <span class="scorm-demo-file-meta">
          ${f ? `登録済み ${escapeHTML(size)} ${escapeHTML(date)}` : "未登録"}
        </span>
      </div>
    `);
  });

  list.innerHTML = rows.join("");
}

// ZIPの中身を取り出す（無圧縮・deflate圧縮のどちらにも対応）
async function readZipEntries(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIPファイルとして読み込めませんでした。");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;

    const lNameLen = view.getUint16(local + 26, true);
    const lExtraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    entries.push({ name, method, raw });
  }
  return entries;
}

async function inflateEntry(entry) {
  if (entry.method === 0) return entry.raw;
  if (entry.method === 8 && "DecompressionStream" in window) {
    const stream = new Blob([entry.raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`「${entry.name}」の圧縮形式に対応していません。`);
}

// 選んだファイル（ZIPを含む）を、登録用の {name, blob} の一覧にする
async function expandDemoFiles(files) {
  const out = [];
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      out.push({ name: file.name, blob: file });
      continue;
    }
    const entries = await readZipEntries(file);
    for (const entry of entries) {
      const base = entry.name.split("/").pop();
      if (!demoPathFor(base)) continue;
      const data = await inflateEntry(entry);
      const type = base.toLowerCase().endsWith(".html") ? "text/html" : "video/mp4";
      out.push({ name: base, blob: new Blob([data], { type }) });
    }
  }
  return out;
}

async function uploadScormDemoFiles(event) {
  event.preventDefault();
  if (!isAdmin) return;

  let files;
  try {
    files = await expandDemoFiles(Array.from($("scormDemoFiles").files || []));
  } catch (error) {
    showMessage("scormDemoUploadMessage", error.message || "ファイルを読み込めませんでした。");
    return;
  }

  if (!files.length) {
    showMessage("scormDemoUploadMessage", "登録できるファイルが見つかりませんでした。");
    return;
  }

  const unknown = files.filter((f) => !demoPathFor(f.name));
  if (unknown.length) {
    showMessage(
      "scormDemoUploadMessage",
      `登録できないファイル名です：${unknown.map((f) => f.name).join("、")}（scorm-demo.html / ja.mp4 / en.mp4 / pt.mp4）`
    );
    return;
  }

  const button = $("scormDemoUploadBtn");
  button.disabled = true;

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      button.textContent = `アップロード中... ${i + 1}/${files.length}`;

      const { error } = await supabase.storage
        .from(DEMO_BUCKET)
        .upload(demoPathFor(file.name), file.blob, {
          upsert: true,
          contentType: file.name.toLowerCase().endsWith(".html") ? "text/html" : "video/mp4"
        });

      if (error) {
        console.error("体験版アップロードエラー:", error);
        throw new Error(`「${file.name}」をアップロードできませんでした。`);
      }
    }

    $("scormDemoUploadForm").reset();
    showMessage("scormDemoUploadMessage", `${files.length}件のファイルを登録しました。`, false);

  } catch (error) {
    showMessage("scormDemoUploadMessage", error.message || "アップロードに失敗しました。");

  } finally {
    button.disabled = false;
    button.textContent = "アップロード";
    await loadScormDemoFiles();
  }
}

// --------------------------------------------------
// 表示切り替え
// --------------------------------------------------

function setAdminView(mode) {
  const preview = mode === "preview";

  $("adminVideoPreview")?.classList.toggle("hidden", !preview);
  $("adminVideoList")?.classList.toggle("hidden", preview);

  $("previewViewBtn")?.classList.toggle("button-primary", preview);
  $("previewViewBtn")?.classList.toggle("button-outline", !preview);

  $("listViewBtn")?.classList.toggle("button-primary", !preview);
  $("listViewBtn")?.classList.toggle("button-outline", preview);
}

// --------------------------------------------------
// イベント設定
// --------------------------------------------------

function setupEvents() {
  bindEvent("categoryNav", "click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;

    currentCategory = button.dataset.category;

    document.querySelectorAll(".category-button").forEach((item) => {
      item.classList.toggle("active", item === button);
    });

    renderVideos();
  });

  bindEvent("searchInput", "input", renderVideos);
  bindEvent("videoForm", "submit", handleVideoSubmit);
  bindEvent("cancelEditBtn", "click", resetVideoForm);

  bindEvent("videoGrid", "click", (event) => {
    const playButton = event.target.closest("[data-play]");
    const editButton = event.target.closest("[data-edit]");
    const deleteButton = event.target.closest("[data-delete]");

    if (playButton) {
      const video = videos.find(
        (item) => String(item.id) === playButton.dataset.play
      );
      if (video) openPlayer(video);
    }

    if (editButton) editVideo(editButton.dataset.edit);
    if (deleteButton) deleteVideo(deleteButton.dataset.delete);
  });

  bindEvent("videoGrid", "keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;

    const target = event.target.closest("[data-play]");
    if (!target) return;

    event.preventDefault();

    const video = videos.find(
      (item) => String(item.id) === target.dataset.play
    );

    if (video) openPlayer(video);
  });

  bindEvent("adminVideoPreview", "click", (event) => {
    const play = event.target.closest("[data-admin-play]");
    const edit = event.target.closest("[data-admin-edit]");
    const del = event.target.closest("[data-admin-delete]");

    if (play) {
      const video = videos.find(
        (item) => String(item.id) === play.dataset.adminPlay
      );
      if (video) openPlayer(video);
    }

    if (edit) editVideo(edit.dataset.adminEdit);
    if (del) deleteVideo(del.dataset.adminDelete);
  });

  bindEvent("adminVideoList", "click", (event) => {
    const edit = event.target.closest("[data-edit]");
    const del = event.target.closest("[data-delete]");

    if (edit) editVideo(edit.dataset.edit);
    if (del) deleteVideo(del.dataset.delete);
  });

  bindEvent("adminVideoList", "change", async (event) => {
    const field = event.target.closest("[data-auto-field]");
    const tag = event.target.closest("[data-auto-tag]");

    if (field) {
      await autoSaveVideoField(
        field.dataset.videoId,
        field.dataset.autoField,
        field.value
      );
    }

    if (tag) {
      const videoId = tag.dataset.videoId;
      const checkedTags = Array.from(
        document.querySelectorAll(
          `[data-auto-tag][data-video-id="${CSS.escape(videoId)}"]:checked`
        )
      ).map((input) => Number(input.dataset.autoTag));

      await autoSaveVideoTags(videoId, checkedTags);
    }
  });

  bindEvent("previewViewBtn", "click", () => setAdminView("preview"));
  bindEvent("listViewBtn", "click", () => setAdminView("list"));

  bindEvent("tagForm", "submit", addTag);

  bindEvent("tagManagementList", "click", (event) => {
    const edit = event.target.closest("[data-edit-tag]");
    const del = event.target.closest("[data-delete-tag]");

    if (edit) editTag(edit.dataset.editTag);
    if (del) deleteTag(del.dataset.deleteTag);
  });

  bindEvent("adminLoginBtn", "click", () => {
    showMessage("loginMessage", "", false);

    if ($("loginDialog")) {
      $("loginDialog").showModal();
      $("loginId")?.focus();
    }
  });

  bindEvent("closeLoginBtn", "click", () => {
    if ($("loginDialog")?.open) $("loginDialog").close();
  });

  bindEvent("loginForm", "submit", login);
  bindEvent("inlineTagAddBtn", "click", createTagInline);
  bindEvent("inlineTagName", "keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      createTagInline();
    }
  });
  bindEvent("adminLogoutBtn", "click", logout);
  bindEvent("createNamedUserForm", "submit", createNamedUser);
  bindEvent("closePlayerBtn", "click", closePlayer);

  bindEvent("openScormDemoBtn", "click", openScormDemo);
  bindEvent("closeScormDemoBtn", "click", closeScormDemo);
  bindEvent("scormDemoDialog", "close", closeScormDemo);
  bindEvent("scormDemoUploadForm", "submit", uploadScormDemoFiles);

  bindEvent("namedUserList", "change", (event) => {
    const demoCheckbox = event.target.closest("[data-demo-user]");
    if (demoCheckbox) {
      changeScormDemoPermission(
        demoCheckbox.dataset.demoUser,
        demoCheckbox.checked
      );
      return;
    }

    const checkbox = event.target.closest("[data-manager-user]");
    if (!checkbox) return;

    changeUserPermission(
      checkbox.dataset.managerUser,
      checkbox.checked
    );
  });

  bindEvent("playerDialog", "click", (event) => {
    if (event.target === $("playerDialog")) closePlayer();
  });
}

// --------------------------------------------------
// リアルタイム更新
// --------------------------------------------------

function setupRealtime() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
  }

  realtimeChannel = supabase
    .channel("public-videos")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "videos"
      },
      () => loadVideos()
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "video_tags_master"
      },
      async () => {
        await loadTags();
        await loadVideos();
      }
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "video_tag_relations"
      },
      () => loadVideos()
    )
    .subscribe();
}

// --------------------------------------------------
// 初期化
// --------------------------------------------------

async function initialize() {
  setupEvents();

  setAdminView("preview");

  const { data, error } = await supabase.auth.getSession();

  if (error) {
    console.error("セッション取得エラー:", error);
  }

  await checkUserRole(data?.session?.user || null);

  supabase.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => {
      checkUserRole(session?.user || null);
    }, 0);
  });

  setupRealtime();
}

initialize();

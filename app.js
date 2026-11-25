
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
let currentUser = null;

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
    public: "一般公開",
    members: "ネームド限定",
    admin: "管理者・動画管理者限定"
  })[visibility] || "一般公開";
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

    const thumbnail =
      `https://i.ytimg.com/vi/${encodeURIComponent(video.youtube_id)}/hqdefault.jpg`;

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
          <img src="${thumbnail}" alt="${title}" loading="lazy">
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

  renderTagCheckboxes();
  showMessage("formMessage", "", false);
}

function renderTagCheckboxes(selectedIds = null) {
  const container = $("videoTagCheckboxes");
  if (!container) return;

  const selected = selectedIds || [];

  if (!tags.length) {
    container.innerHTML =
      '<span class="muted-text">登録されているタグはありません。</span>';
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

  player.src =
    `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.youtube_id)}?autoplay=1`;

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
  $("videoUrl").value =
    `https://www.youtube.com/watch?v=${video.youtube_id}`;
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
        const thumbnail =
          `https://i.ytimg.com/vi/${encodeURIComponent(video.youtube_id)}/hqdefault.jpg`;

        return `
          <article class="video-card">
            <div class="video-thumbnail"
                 role="button"
                 tabindex="0"
                 data-admin-play="${id}">
              <img src="${thumbnail}" alt="${title}" loading="lazy">
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
}

// --------------------------------------------------
// 管理画面：リスト表示と自動保存
// --------------------------------------------------

function renderAdminVideoList() {
  const container = $("adminVideoList");
  if (!container || !canManageVideos()) return;

  if (!videos.length) {
    container.innerHTML =
      '<p class="muted-text">登録されている動画はありません。</p>';
    return;
  }

  container.innerHTML = videos.map((video) => {
    const id = escapeHTML(video.id);
    const selectedTagIds = videoTagMap[String(video.id)] || [];

    return `
      <div class="admin-video-row" data-row-id="${id}">
        <div class="admin-video-row-title">
          <strong>${escapeHTML(video.title)}</strong>
          <span>${escapeHTML(video.category)}</span>
        </div>

        <div class="admin-video-row-fields">
          <label>
            カテゴリ
            <select data-auto-field="category" data-video-id="${id}">
              ${CATEGORIES.map((category) => `
                <option value="${escapeHTML(category)}"
                  ${video.category === category ? "selected" : ""}>
                  ${escapeHTML(category)}
                </option>
              `).join("")}
            </select>
          </label>

          <label>
            公開範囲
            <select data-auto-field="visibility" data-video-id="${id}">
              <option value="public" ${video.visibility === "public" ? "selected" : ""}>全体公開</option>
              <option value="members" ${video.visibility === "members" ? "selected" : ""}>ログインユーザー限定</option>
              <option value="admin" ${video.visibility === "admin" ? "selected" : ""}>管理者・動画管理者限定</option>
            </select>
          </label>
        </div>

        <div class="admin-video-row-tags">
          <span>タグ</span>
          <div class="tag-checkbox-list">
            ${tags.map((tag) => `
              <label class="tag-checkbox">
                <input
                  type="checkbox"
                  data-auto-tag="${escapeHTML(tag.id)}"
                  data-video-id="${id}"
                  ${selectedTagIds.some((tagId) => Number(tagId) === Number(tag.id)) ? "checked" : ""}
                >
                <span>${escapeHTML(tag.name)}</span>
              </label>
            `).join("")}
          </div>
        </div>

        <div class="admin-video-row-footer">
          <span class="auto-save-status" data-save-status="${id}">変更は自動保存されます</span>
          <button type="button" class="small-button" data-edit="${id}">詳細編集</button>
          <button type="button" class="small-button delete" data-delete="${id}">削除</button>
        </div>
      </div>
    `;
  }).join("");
}

async function autoSaveVideoField(videoId, field, value) {
  if (!canManageVideos()) return;

  const status = document.querySelector(
    `[data-save-status="${CSS.escape(String(videoId))}"]`
  );

  if (status) {
    status.textContent = "保存中...";
    status.style.color = "#a36a13";
  }

  const { error } = await supabase
    .from("videos")
    .update({ [field]: value })
    .eq("id", videoId);

  if (error) {
    console.error("自動保存エラー:", error);

    if (status) {
      status.textContent = "保存失敗：もう一度変更してください";
      status.style.color = "#b13d3d";
    }
    return;
  }

  const video = videos.find(
    (item) => String(item.id) === String(videoId)
  );

  if (video) video[field] = value;

  if (status) {
    status.textContent = "保存しました";
    status.style.color = "#287449";
  }

  renderVideos();
  renderAdminVideoPreview();
}

async function autoSaveVideoTags(videoId, tagIds) {
  if (!canManageVideos()) return;

  const status = document.querySelector(
    `[data-save-status="${CSS.escape(String(videoId))}"]`
  );

  if (status) {
    status.textContent = "タグ保存中...";
    status.style.color = "#a36a13";
  }

  const error = await saveVideoTags(videoId, tagIds);

  if (error) {
    if (status) {
      status.textContent = "タグ保存失敗：もう一度変更してください";
      status.style.color = "#b13d3d";
    }
    return;
  }

  videoTagMap[String(videoId)] = tagIds;

  if (status) {
    status.textContent = "保存しました";
    status.style.color = "#287449";
  }

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

async function adminLogin(event) {
  event.preventDefault();
  showMessage("loginMessage", "");

  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    console.error("管理者ログインエラー:", error);
    showMessage(
      "loginMessage",
      "ログインできませんでした。メールアドレスとパスワードを確認してください。"
    );
    return;
  }

  $("loginDialog").close();
  $("adminLoginForm").reset();
}

async function memberLogin(event) {
  event.preventDefault();
  showMessage("memberLoginMessage", "");

  const username = $("memberUsername").value.trim();
  const password = $("memberPassword").value;

  if (!username) {
    showMessage("memberLoginMessage", "ログインIDを入力してください。");
    return;
  }

  try {
    const internalEmail = await makeInternalEmail(username);

    const { error } = await supabase.auth.signInWithPassword({
      email: internalEmail,
      password
    });

    if (error) {
      console.error("ユーザーログインエラー:", error);
      showMessage(
        "memberLoginMessage",
        "ログインできませんでした。IDとパスワードを確認してください。"
      );
      return;
    }

    $("loginDialog").close();
    $("memberLoginForm").reset();

  } catch (error) {
    console.error(error);
    showMessage(
      "memberLoginMessage",
      "ログイン処理に失敗しました。もう一度お試しください。"
    );
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
  }

  updateAdminView();

  await loadTags();
  await loadVideos();

  if (isAdmin) {
    await loadNamedUsers();
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
    .select("username, is_active, created_at, video_management_enabled")
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

      <label class="permission-toggle">
        <input
          type="checkbox"
          data-manager-user="${escapeHTML(user.username)}"
          ${user.video_management_enabled ? "checked" : ""}
          ${!user.is_active ? "disabled" : ""}
        >
        <span>動画管理権限</span>
      </label>
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
    showMessage("memberLoginMessage", "", false);

    if ($("loginDialog")) $("loginDialog").showModal();
  });

  bindEvent("closeLoginBtn", "click", () => {
    if ($("loginDialog")?.open) $("loginDialog").close();
  });

  bindEvent("adminLoginForm", "submit", adminLogin);
  bindEvent("memberLoginForm", "submit", memberLogin);
  bindEvent("adminLogoutBtn", "click", logout);
  bindEvent("createNamedUserForm", "submit", createNamedUser);
  bindEvent("closePlayerBtn", "click", closePlayer);

  bindEvent("namedUserList", "change", (event) => {
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

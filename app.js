
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

let videos = [];
let currentCategory = "新着動画";
let isAdmin = false;
let isNamedUser = false;
let currentUser = null;

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
    admin: "管理者限定"
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

// ログインIDから内部メールアドレスを生成
async function makeInternalEmail(username) {
  const bytes = new TextEncoder().encode(username);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `u-${hash.slice(0, 48)}@named-login.invalid`;
}

// 動画取得
async function loadVideos() {
  const grid = $("videoGrid");
  if (!grid) return;

  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("動画取得エラー:", error);
    grid.innerHTML =
      '<div class="empty-state">動画を読み込めませんでした。</div>';
    return;
  }

  videos = data || [];
  renderVideos();
}

// 動画絞り込み
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
    const searchable = [
      video.title,
      video.description,
      video.category
    ].join(" ").toLowerCase();

    return searchable.includes(keyword);
  });
}

// 動画一覧表示
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

          ${isAdmin ? `
            <span class="video-visibility">
              ${escapeHTML(getVisibilityLabel(video.visibility))}
            </span>
          ` : ""}

          <h4>${title}</h4>
          <p>${description || "説明はありません。"}</p>
        </div>

        ${isAdmin ? `
          <div class="video-card-actions">
            <button class="small-button" data-edit="${id}">編集</button>
            <button class="small-button delete" data-delete="${id}">削除</button>
          </div>
        ` : ""}
      </article>
    `;
  }).join("");
}

// 管理者画面更新
function updateAdminView() {
  if ($("adminPanel")) {
    $("adminPanel").classList.toggle("hidden", !isAdmin);
  }

  if ($("adminLoginBtn")) {
    $("adminLoginBtn").classList.toggle("hidden", !!currentUser);
  }

  if ($("adminLogoutBtn")) {
    $("adminLogoutBtn").classList.toggle("hidden", !currentUser);
  }

  renderVideos();
}

// 動画フォーム初期化
function resetVideoForm() {
  if ($("videoForm")) $("videoForm").reset();
  if ($("editVideoId")) $("editVideoId").value = "";
  if ($("videoVisibility")) $("videoVisibility").value = "public";
  if ($("saveVideoBtn")) $("saveVideoBtn").textContent = "動画を登録";
  if ($("cancelEditBtn")) $("cancelEditBtn").classList.add("hidden");

  showMessage("formMessage", "", false);
}

// 動画再生
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

// 動画登録・編集
async function handleVideoSubmit(event) {
  event.preventDefault();

  if (!isAdmin) {
    showMessage("formMessage", "管理者ログインが必要です。");
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

  if (!title) {
    showMessage("formMessage", "動画タイトルを入力してください。");
    return;
  }

  if (!["public", "members", "admin"].includes(visibility)) {
    showMessage("formMessage", "公開範囲を選択してください。");
    return;
  }

  $("saveVideoBtn").disabled = true;

  const payload = {
    youtube_id: youtubeId,
    title,
    description,
    category,
    visibility
  };

  let result;

  try {
    result = editId
      ? await supabase.from("videos").update(payload).eq("id", editId)
      : await supabase.from("videos").insert(payload);
  } catch (error) {
    console.error(error);
    showMessage("formMessage", "保存中にエラーが発生しました。");
    $("saveVideoBtn").disabled = false;
    return;
  }

  $("saveVideoBtn").disabled = false;

  if (result.error) {
    console.error(result.error);
    showMessage("formMessage", "保存に失敗しました。権限設定を確認してください。");
    return;
  }

  resetVideoForm();
  showMessage("formMessage", "動画を保存しました。", false);
  await loadVideos();
}

// 動画編集
function editVideo(id) {
  if (!isAdmin) return;

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

  $("saveVideoBtn").textContent = "変更を保存";
  $("cancelEditBtn").classList.remove("hidden");
  $("adminPanel").scrollIntoView({ behavior: "smooth" });
}

// 動画削除
async function deleteVideo(id) {
  if (!isAdmin) return;

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
    alert("削除できませんでした。管理者権限を確認してください。");
    return;
  }

  await loadVideos();
}

// 管理者ログイン
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

// ネームドユーザーログイン
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

// ログアウト
async function logout() {
  const { error } = await supabase.auth.signOut();

  if (error) {
    console.error(error);
    alert("ログアウトできませんでした。");
    return;
  }

  resetVideoForm();
}

// ログインユーザーの権限確認
async function checkUserRole(user) {
  currentUser = user || null;
  isAdmin = false;
  isNamedUser = false;

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

    if (!isAdmin) {
      const { data: namedData, error: namedError } =
        await supabase.rpc("is_named_user");

      if (namedError) {
        console.error("ユーザー権限確認エラー:", namedError);
      }

      isNamedUser = namedData === true;
    }
  }

  updateAdminView();
  await loadVideos();

  if (isAdmin) {
    await loadNamedUsers();
  } else if ($("namedUserList")) {
    $("namedUserList").innerHTML = "";
  }
}

// ネームドユーザー発行
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
      throw new Error("ユーザーを発行できませんでした。IDの重複や関数の設定を確認してください。");
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
    button.textContent = "ユーザーを発行";
  }
}

// ネームドユーザー一覧
async function loadNamedUsers() {
  if (!isAdmin) return;

  const list = $("namedUserList");
  if (!list) return;

  const { data, error } = await supabase
    .from("named_users")
    .select("username, is_active, created_at")
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
      <span class="named-user-name">
        ${escapeHTML(user.username)}
      </span>
      <span class="named-user-status ${user.is_active ? "" : "inactive"}">
        ${user.is_active ? "利用中" : "利用停止中"}
      </span>
    </div>
  `).join("");
}

// リアルタイム更新
function setupRealtime() {
  supabase
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
    .subscribe();
}

// イベント設定
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

  bindEvent("playerDialog", "click", (event) => {
    if (event.target === $("playerDialog")) closePlayer();
  });
}

// 初期化
async function initialize() {
  setupEvents();

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

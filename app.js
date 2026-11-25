
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);

let videos = [];
let currentCategory = "新着動画";
let isAdmin = false;

const categories = [
  "新着動画",
  "KYT",
  "フォークリフト",
  "テールゲートリフト",
  "安全講習"
];

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function getYouTubeId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return parsed.pathname.split("/").filter(Boolean)[0] || null;
    }

    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtube-nocookie.com"
    ) {
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

function showMessage(elementId, message, isError = true) {
  const element = $(elementId);
  element.textContent = message;
  element.style.color = isError ? "#b13d3d" : "#287449";
}

async function loadVideos() {
  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("動画の取得に失敗:", error);
    $("videoGrid").innerHTML =
      '<div class="empty-state">動画を読み込めませんでした。Supabaseの設定を確認してください。</div>';
    return;
  }

  videos = data || [];
  renderVideos();
}

function getFilteredVideos() {
  const keyword = $("searchInput").value.trim().toLowerCase();

  return videos.filter((video) => {
    const matchesCategory =
      currentCategory === "新着動画" ||
      video.category === currentCategory;

    const searchable = [
      video.title,
      video.description,
      video.category
    ].join(" ").toLowerCase();

    return matchesCategory && searchable.includes(keyword);
  });
}

function renderVideos() {
  const filtered = getFilteredVideos();

  $("currentCategory").textContent = currentCategory;
  $("videoCount").textContent = `${filtered.length}本`;

  if (filtered.length === 0) {
    $("videoGrid").innerHTML =
      '<div class="empty-state">該当する動画はありません。</div>';
    return;
  }

  $("videoGrid").innerHTML = filtered.map((video) => {
    const id = escapeHTML(video.id);
    const title = escapeHTML(video.title);
    const description = escapeHTML(video.description || "");
    const category = escapeHTML(video.category);
    const thumbnail = `https://i.ytimg.com/vi/${encodeURIComponent(video.youtube_id)}/hqdefault.jpg`;

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

function updateAdminView() {
  $("adminPanel").classList.toggle("hidden", !isAdmin);
  $("adminLoginBtn").classList.toggle("hidden", isAdmin);
  $("adminLogoutBtn").classList.toggle("hidden", !isAdmin);
  renderVideos();
}

function resetVideoForm() {
  $("videoForm").reset();
  $("editVideoId").value = "";
  $("saveVideoBtn").textContent = "動画を登録";
  $("cancelEditBtn").classList.add("hidden");
  showMessage("formMessage", "", false);
}

function openPlayer(video) {
  $("playerTitle").textContent = video.title;
  $("playerDescription").textContent = video.description || "";
  $("youtubePlayer").src =
    `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.youtube_id)}?autoplay=1`;

  $("playerDialog").showModal();
}

function closePlayer() {
  $("youtubePlayer").src = "";
  $("playerDialog").close();
}

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
  const editId = $("editVideoId").value;

  if (!title) {
    showMessage("formMessage", "動画タイトルを入力してください。");
    return;
  }

  $("saveVideoBtn").disabled = true;

  const payload = {
    youtube_id: youtubeId,
    title,
    description,
    category
  };

  let result;

  if (editId) {
    result = await supabase
      .from("videos")
      .update(payload)
      .eq("id", editId);
  } else {
    result = await supabase
      .from("videos")
      .insert(payload);
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

async function editVideo(id) {
  if (!isAdmin) return;

  const video = videos.find((item) => String(item.id) === String(id));
  if (!video) return;

  $("editVideoId").value = video.id;
  $("videoUrl").value = `https://www.youtube.com/watch?v=${video.youtube_id}`;
  $("videoTitle").value = video.title;
  $("videoDescription").value = video.description || "";
  $("videoCategory").value = video.category;

  $("saveVideoBtn").textContent = "変更を保存";
  $("cancelEditBtn").classList.remove("hidden");

  $("adminPanel").scrollIntoView({ behavior: "smooth" });
}

async function deleteVideo(id) {
  if (!isAdmin) return;

  const video = videos.find((item) => String(item.id) === String(id));
  if (!video) return;

  if (!confirm(`「${video.title}」を削除しますか？`)) return;

  const { error } = await supabase
    .from("videos")
    .delete()
    .eq("id", id);

  if (error) {
    alert("削除できませんでした。管理者権限を確認してください。");
    console.error(error);
    return;
  }

  await loadVideos();
}

async function login(event) {
  event.preventDefault();

  showMessage("loginMessage", "");

  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    showMessage("loginMessage", "ログインできませんでした。メールアドレスとパスワードを確認してください。");
    return;
  }

  $("loginDialog").close();
  $("loginForm").reset();
}

async function logout() {
  const { error } = await supabase.auth.signOut();

  if (error) {
    alert("ログアウトできませんでした。");
    return;
  }

  resetVideoForm();
}

async function checkAdmin(user) {
  if (!user) {
    isAdmin = false;
    updateAdminView();
    return;
  }

  const { data, error } = await supabase
    .from("video_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("管理者確認エラー:", error);
  }

  isAdmin = !!data;
  updateAdminView();
}

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

function setupEvents() {
  $("categoryNav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;

    currentCategory = button.dataset.category;

    document.querySelectorAll(".category-button").forEach((item) => {
      item.classList.toggle("active", item === button);
    });

    renderVideos();
  });

  $("searchInput").addEventListener("input", renderVideos);

  $("videoForm").addEventListener("submit", handleVideoSubmit);

  $("cancelEditBtn").addEventListener("click", resetVideoForm);

  $("videoGrid").addEventListener("click", (event) => {
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

  $("videoGrid").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;

    const target = event.target.closest("[data-play]");
    if (!target) return;

    event.preventDefault();

    const video = videos.find(
      (item) => String(item.id) === target.dataset.play
    );
    if (video) openPlayer(video);
  });

  $("adminLoginBtn").addEventListener("click", () => {
    $("loginMessage").textContent = "";
    $("loginDialog").showModal();
  });

  $("closeLoginBtn").addEventListener("click", () => {
    $("loginDialog").close();
  });

  $("loginForm").addEventListener("submit", login);
  $("adminLogoutBtn").addEventListener("click", logout);

  $("closePlayerBtn").addEventListener("click", closePlayer);

  $("playerDialog").addEventListener("click", (event) => {
    if (event.target === $("playerDialog")) closePlayer();
  });
}

async function initialize() {
  setupEvents();

  await loadVideos();

  const { data } = await supabase.auth.getSession();
  await checkAdmin(data.session?.user || null);

  supabase.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => {
      checkAdmin(session?.user || null);
    }, 0);
  });

  setupRealtime();
}

initialize();

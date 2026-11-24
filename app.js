/*
 * Тренажёр охотминимума — Telegram Mini App в стиле QUARTA (HUD оптического прицела).
 * Режимы как у тренажёра ПДД от Дрома: экзамен на время, быстрый билет, темы, мои ошибки, марафон, избранное.
 * Экзамен — как в органе власти (постановление Правительства № 1227): 100 вопросов официального перечня,
 * минута на вопрос, сдал — 75&nbsp;% верных и больше. Прогресс хранится в облаке Telegram (CloudStorage),
 * поэтому он одинаковый на телефоне и компьютере. Вне Telegram — в браузере.
 */
(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  const inTg = !!(tg && tg.initData);
  const Q = window.QUESTIONS || [];
  const TOPICS = window.TOPICS || [];
  const byId = new Map(Q.map((q) => [q.id, q]));
  const OFFICIAL = Q.filter((q) => q.s === "m");
  const EXAM_SIZE = 100;
  const QUICK_SIZE = 20;
  const PASS = 0.75;
  const LETTERS = ["а", "б", "в", "г", "д", "е"];
  const SITE = "https://quarta-hunt.ru/";
  const BG = "#f4f6f9";
  const root = document.getElementById("app");
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ───────── Telegram ───────── */

  const can = (v) => inTg && typeof tg.isVersionAtLeast === "function" && tg.isVersionAtLeast(v);
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      if (can("6.1")) {
        tg.setHeaderColor(BG);
        tg.setBackgroundColor(BG);
      }
      if (can("7.10") && tg.setBottomBarColor) tg.setBottomBarColor(BG);
      if (can("7.7") && tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    } catch (e) {}
  }
  const haptic = {
    ok() { try { can("6.1") && tg.HapticFeedback.notificationOccurred("success"); } catch (e) {} },
    bad() { try { can("6.1") && tg.HapticFeedback.notificationOccurred("error"); } catch (e) {} },
    tap() { try { can("6.1") && tg.HapticFeedback.impactOccurred("light"); } catch (e) {} },
  };
  // Подтверждение: в Telegram — родное окно, в браузере — своё (системный confirm бывает запрещён).
  function confirmBox(text, cb) {
    if (can("6.2")) return tg.showConfirm(text, (ok) => ok && cb());
    const d = document.createElement("div");
    d.className = "dlg";
    d.innerHTML = `<div class="dlg-box glass" role="dialog" aria-modal="true"><p></p><div class="dlg-acts"><button class="btn sec" data-r="0">Отмена</button><button class="btn acc" data-r="1">Да</button></div></div>`;
    d.querySelector("p").textContent = text;
    d.addEventListener("click", (e) => {
      const b = e.target.closest("[data-r]");
      if (!b && e.target !== d) return;
      d.remove();
      if (b && b.dataset.r === "1") cb();
    });
    document.body.appendChild(d);
    d.querySelector("[data-r='1']").focus();
  }
  function openSite() {
    if (inTg) return tg.openLink(SITE);
    const a = document.createElement("a");
    a.href = SITE;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  let backHandler = null;
  function setBack(fn) {
    backHandler = fn;
    if (!can("6.1")) return;
    if (fn) tg.BackButton.show();
    else tg.BackButton.hide();
  }
  if (can("6.1")) tg.BackButton.onClick(() => backHandler && backHandler());

  /* ───────── Хранилище: облако Telegram, иначе браузер ───────── */

  const cloud = can("6.9") && tg.CloudStorage;
  const PREFIX = "quarta.ohot.";
  const KEYS = ["a0", "a1", "a2", "a3", "a4", "fav", "ex", "mar"];
  function readLocal() {
    const o = {};
    for (const k of KEYS) {
      try { o[k] = localStorage.getItem(PREFIX + k) || ""; } catch (e) { o[k] = ""; }
    }
    return o;
  }
  function readAll() {
    return new Promise((resolve) => {
      if (!cloud) return resolve(readLocal());
      let done = false;
      const fallback = setTimeout(() => { if (!done) { done = true; resolve(readLocal()); } }, 2500);
      try {
        tg.CloudStorage.getItems(KEYS, (err, vals) => {
          if (done) return;
          done = true;
          clearTimeout(fallback);
          resolve(err || !vals ? readLocal() : vals);
        });
      } catch (e) { done = true; clearTimeout(fallback); resolve(readLocal()); }
    });
  }
  function write(k, v) {
    try { localStorage.setItem(PREFIX + k, v); } catch (e) {}
    if (cloud) { try { tg.CloudStorage.setItem(k, v, () => {}); } catch (e) {} }
  }

  /* Состояние: ответ по вопросу (g — последний верно, b — ошибка), избранное, экзамены, место в марафоне. */
  const S = { ans: {}, fav: new Set(), exams: [], mar: 0 };
  function load(v) {
    for (const k of ["a0", "a1", "a2", "a3", "a4"]) {
      for (const part of (v[k] || "").split(";")) {
        const [id, st] = part.split(":");
        if (id && byId.has(id) && (st === "g" || st === "b")) S.ans[id] = st;
      }
    }
    S.fav = new Set((v.fav || "").split(",").filter((id) => byId.has(id)));
    try { S.exams = JSON.parse(v.ex || "[]").slice(0, 10); } catch (e) { S.exams = []; }
    S.mar = Math.min(Math.max(0, parseInt(v.mar, 10) || 0), Math.max(0, Q.length - 1));
  }
  let saveTimer = null;
  const dirty = new Set();
  function save(...what) {
    what.forEach((w) => dirty.add(w));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }
  function flush() {
    if (dirty.has("ans")) {
      // Значение в облаке Telegram — до 4096 символов, поэтому делим на части.
      const parts = [];
      let cur = "";
      for (const id in S.ans) {
        const t = id + ":" + S.ans[id] + ";";
        if (cur.length + t.length > 3800) { parts.push(cur); cur = ""; }
        cur += t;
      }
      parts.push(cur);
      for (let i = 0; i < 5; i++) write("a" + i, parts[i] || "");
    }
    if (dirty.has("fav")) write("fav", [...S.fav].join(","));
    if (dirty.has("ex")) write("ex", JSON.stringify(S.exams));
    if (dirty.has("mar")) write("mar", String(S.mar));
    dirty.clear();
  }
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());

  /* ───────── Логика ───────── */

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const weight = (q) => (S.ans[q.id] === "b" ? 3 : S.ans[q.id] ? 0 : 2);
  function stats(list) {
    let seen = 0, good = 0, bad = 0;
    for (const q of list) {
      const a = S.ans[q.id];
      if (!a) continue;
      seen++;
      if (a === "g") good++; else bad++;
    }
    return { total: list.length, seen, good, bad };
  }
  const topicTitle = (id) => (TOPICS.find((t) => t.id === id) || {}).title || "";
  const mistakesList = () => Q.filter((q) => S.ans[q.id] === "b");
  const favList = () => Q.filter((q) => S.fav.has(q.id));

  function pick(kind, topic) {
    switch (kind) {
      case "exam": return shuffle(OFFICIAL.length >= EXAM_SIZE ? OFFICIAL : Q).slice(0, EXAM_SIZE);
      case "quick": return shuffle(Q).sort((a, b) => weight(b) - weight(a)).slice(0, QUICK_SIZE);
      case "topic": return shuffle(Q.filter((q) => q.t === topic));
      case "mistakes": return shuffle(mistakesList());
      case "fav": return shuffle(favList());
      case "marathon": return Q.slice();
      default: return [];
    }
  }
  const toCard = (q) => ({ q, order: shuffle(q.o.map((_, i) => i)) });

  /* ───────── Графика ───────── */

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  };
  const clock = (ms) => {
    const s = Math.ceil(ms / 1000);
    const m = Math.floor(s / 60);
    return (m >= 60 ? Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0") : m) + ":" + String(s % 60).padStart(2, "0");
  };
  const fmtDate = (iso) => {
    try { return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }); } catch (e) { return ""; }
  };

  const svg = (d, w = 2.2, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>', 2.6, 22),
    bolt: svg('<path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/>'),
    redo: svg('<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/>'),
    road: svg('<path d="M12 3v3M12 10v4M12 18v3M5 21 9 3M19 21 15 3"/>'),
    star: svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>'),
    starOn: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/></svg>',
    starOff: svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>', 2, 22),
    chev: svg('<path d="m9 6 6 6-6 6"/>', 2.4, 18),
    timer: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>', 2.2, 16),
  };
  const LOGO = '<img class="logo" src="logo.svg" alt="QUARTA" width="129" height="15" />';

  /* Прицельная сетка: лимб с рисками, дуга прогресса со свечением, перекрестие с разрывом. */
  let uid = 0;
  function scope(pct, label, color) {
    const id = "s" + ++uid;
    const R = 112, C = 2 * Math.PI * R;
    let ticks = "";
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2, big = i % 6 === 0;
      const r1 = big ? 128 : 131, r2 = 137;
      ticks += `<line x1="${(150 + r1 * Math.cos(a)).toFixed(1)}" y1="${(150 + r1 * Math.sin(a)).toFixed(1)}" x2="${(150 + r2 * Math.cos(a)).toFixed(1)}" y2="${(150 + r2 * Math.sin(a)).toFixed(1)}" stroke="rgba(156,200,240,${big ? 0.55 : 0.22})" stroke-width="${big ? 2 : 1}"/>`;
    }
    const c1 = color === "ok" ? "#7af5b3" : "#ffb06b";
    const c2 = color === "ok" ? "#14a35a" : "#eb5806";
    const arc = pct > 0
      ? `<circle cx="150" cy="150" r="${R}" fill="none" stroke="url(#${id}g)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${((pct / 100) * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 150 150)" filter="url(#${id}f)"/>`
      : "";
    return `<div class="scope">
      <svg viewBox="0 0 300 300" aria-hidden="true">
        <defs>
          <linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
          <filter id="${id}f" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <radialGradient id="${id}r" cx=".5" cy=".5" r=".5"><stop offset=".7" stop-color="rgba(26,111,192,0)"/><stop offset="1" stop-color="rgba(26,111,192,.35)"/></radialGradient>
        </defs>
        <circle cx="150" cy="150" r="146" fill="url(#${id}r)"/>
        <g>${ticks}
          <path d="M150 4v14M150 282v14M4 150h14M282 150h14" stroke="#ff9047" stroke-width="2.5" stroke-linecap="round"/>
        </g>
        <circle cx="150" cy="150" r="${R}" fill="none" stroke="rgba(156,200,240,.1)" stroke-width="10"/>
        ${arc}
        <path d="M150 22v38M150 240v38M22 150h38M240 150h38" stroke="rgba(237,243,249,.5)" stroke-width="1.5"/>
      </svg>
      <div class="core"><div><b class="num">${pct}<small>%</small></b><span>${esc(label)}</span></div></div>
    </div>`;
  }
  function mini(st) {
    const R = 19, C = 2 * Math.PI * R;
    const g = st.total ? (st.good / st.total) * C : 0;
    const b = st.total ? (st.bad / st.total) * C : 0;
    const pct = st.total ? Math.round((st.seen / st.total) * 100) : 0;
    return `<div class="mini"><svg viewBox="0 0 46 46">
      <circle cx="23" cy="23" r="${R}" fill="none" stroke="#e6e9ef" stroke-width="4"/>
      ${g ? `<circle cx="23" cy="23" r="${R}" fill="none" stroke="#2bb673" stroke-width="4" stroke-dasharray="${g.toFixed(1)} ${C.toFixed(1)}"/>` : ""}
      ${b ? `<circle cx="23" cy="23" r="${R}" fill="none" stroke="#e22b2b" stroke-width="4" stroke-dasharray="${b.toFixed(1)} ${C.toFixed(1)}" stroke-dashoffset="${(-g).toFixed(1)}"/>` : ""}
    </svg><em class="num">${pct}%</em></div>`;
  }

  /* ───────── Экраны ───────── */

  let run = null; // { kind, title, cards, answers, i, startedAt, limit }
  let timer = null;

  function home() {
    stopTimer();
    run = null;
    setBack(null);
    if (can("6.2")) tg.disableClosingConfirmation();
    const all = stats(Q);
    const pct = all.total ? Math.round((all.good / all.total) * 100) : 0;
    const mist = all.bad;
    const fav = S.fav.size;
    const last = S.exams[0];
    const marPct = Q.length ? Math.round((S.mar / Q.length) * 100) : 0;

    root.innerHTML = `
      <div class="wrap enter">
        <div class="top">${LOGO}<div class="status"><i></i>${cloud ? "Синхронизировано" : "Тренажёр"}</div></div>
        <header class="hero">
          <h1>Охотминимум</h1>
          <p>Подготовка к проверке знаний на охотничий билет — все вопросы перечня Минприроды России</p>
          ${scope(pct, "Готовность")}
          <div class="metrics">
            <div class="metric"><b class="num">${all.seen}</b><span>из ${all.total}</span></div>
            <div class="metric ok"><b class="num">${all.good}</b><span>Верно</span></div>
            <div class="metric bad"><b class="num">${mist}</b><span>Ошибки</span></div>
          </div>
        </header>

        <main class="body">
          <button class="exam tilt" data-act="start" data-kind="exam">
            <div class="t"><b>Экзамен</b><span>${Math.min(EXAM_SIZE, OFFICIAL.length || Q.length)} вопросов · ${Math.min(EXAM_SIZE, OFFICIAL.length || Q.length)} минут · сдача от 75&nbsp;%</span>
              ${last ? `<span style="margin-top:8px"><span class="pill" style="background:rgba(0,0,0,.2);color:#fff">Последний: ${last.correct}/${last.total} · ${last.passed ? "сдан" : "не сдан"}</span></span>` : ""}
            </div>
            <div class="go">${ICON.arrow}</div>
          </button>

          <div class="bento">
            <button class="tile glass tilt" data-act="start" data-kind="quick"><div class="lens o">${ICON.bolt}</div><div><b>Быстрый билет</b><span>${QUICK_SIZE} вопросов, сначала новые и ошибки</span></div></button>
            <button class="tile glass tilt" data-act="start" data-kind="mistakes" ${mist ? "" : "disabled"}><div class="lens r">${ICON.redo}</div><div><b>Мои ошибки</b><span>${mist ? `${mist} ${plural(mist, "вопрос", "вопроса", "вопросов")} — повторить` : "Пока нет"}</span></div></button>
            <button class="tile wide glass tilt" data-act="start" data-kind="marathon"><div class="lens">${ICON.road}</div>
              <div class="grow"><b>Марафон</b><span>${S.mar > 0 ? `Продолжить с ${S.mar + 1}-го из ${Q.length}` : `Все ${Q.length} ${plural(Q.length, "вопрос", "вопроса", "вопросов")} по порядку`}</span><div class="track"><i style="width:${marPct}%"></i></div></div>
              <span class="chev">${ICON.chev}</span></button>
            <button class="tile wide glass tilt" data-act="start" data-kind="fav" ${fav ? "" : "disabled"}><div class="lens g">${ICON.star}</div>
              <div class="grow"><b>Избранное</b><span>${fav ? `${fav} ${plural(fav, "вопрос", "вопроса", "вопросов")}` : "Отмечайте ★ сложные вопросы"}</span></div>
              <span class="chev">${ICON.chev}</span></button>
          </div>

          <div class="sect label">По темам</div>
          <div class="topics">
            ${TOPICS.map((t) => {
              const list = Q.filter((q) => q.t === t.id);
              if (!list.length) return "";
              const st = stats(list);
              return `<button class="topic glass tilt" data-act="start" data-kind="topic" data-topic="${esc(t.id)}">
                ${mini(st)}
                <div class="t"><b>${esc(t.title)}</b><span><span class="num">${st.seen}/${st.total}</span> · ${esc(t.text)}</span></div>
                <span class="chev">${ICON.chev}</span>
              </button>`;
            }).join("")}
          </div>

          ${S.exams.length ? `<div class="sect label">Мои экзамены</div><div class="glass">${S.exams.slice(0, 5).map((e) => `
            <div class="hist"><span>${fmtDate(e.at)} · <b class="num">${e.correct}/${e.total}</b></span><span class="pill ${e.passed ? "ok" : "bad"}">${e.passed ? "Сдан" : "Не сдан"}</span></div>`).join("")}</div>` : ""}

          <section class="note glass">
            <b>Как проходит проверка</b>
            <p>С 1 сентября 2025 года охотничий билет выдают только после проверки знаний. Её проводит региональный орган охотнадзора по постановлению Правительства № 1227: от 100 до 200 вопросов, не меньше минуты на вопрос, нужно ответить верно на 75&nbsp;% и больше. Пересдача — не раньше чем через месяц.</p>
            <p>В тренажёре — все ${OFFICIAL.length} вопросов официального перечня Минприроды России (утверждён 18.09.2025), экзамен собирается только из них. Плюс ${Q.length - OFFICIAL.length} тренировочных вопросов по Правилам охоты с пояснениями и номерами пунктов.</p>
            <p>Прогресс ${cloud ? "хранится в Telegram и виден на всех ваших устройствах" : "хранится в этом браузере"}.</p>
            <button class="linkbtn" data-act="reset">Сбросить прогресс</button>
          </section>
        </main>

        <footer class="foot">${LOGO}<div class="tag">Надёжность. Точность. Сделано в России.</div><button data-act="site">quarta-hunt.ru</button></footer>
      </div>`;
    window.scrollTo(0, 0);
  }

  function start(kind, topic, cards) {
    haptic.tap();
    const list = cards ? null : pick(kind, topic);
    if (!cards && !list.length) return;
    const titles = { exam: "Экзамен", quick: "Билет", mistakes: "Мои ошибки", marathon: "Марафон", fav: "Избранное", topic: topicTitle(topic), redo: "Работа над ошибками" };
    const deck = cards || list.map(toCard);
    run = {
      kind,
      title: titles[kind] || "Билет",
      cards: deck,
      answers: deck.map(() => null),
      i: kind === "marathon" ? S.mar : 0,
      startedAt: Date.now(),
      limit: deck.length * 60000,
      fresh: true,
    };
    if (kind === "exam") {
      if (can("6.2")) tg.enableClosingConfirmation();
      startTimer();
    }
    quiz();
  }

  function stopTimer() { clearInterval(timer); timer = null; }
  function startTimer() {
    stopTimer();
    timer = setInterval(() => {
      if (!run || run.kind !== "exam" || run.done) return stopTimer();
      const left = run.limit - (Date.now() - run.startedAt);
      const el = document.getElementById("clock");
      if (el) {
        el.textContent = clock(Math.max(0, left));
        el.classList.toggle("warn", left < 5 * 60000);
      }
      if (left <= 0) finish();
    }, 1000);
  }

  function quiz() {
    const exam = run.kind === "exam";
    const card = run.cards[run.i];
    const q = card.q;
    const chosen = run.answers[run.i];
    const answered = run.answers.filter((a) => a !== null).length;
    const lastQ = run.i === run.cards.length - 1;
    const reveal = chosen !== null && !exam;
    setBack(leaveQuiz);

    const chips = run.cards.map((c, i) => {
      const a = run.answers[i];
      const st = a === null ? "" : exam ? "done" : a === c.q.a ? "ok" : "bad";
      return `<button class="chip num ${st} ${i === run.i ? "cur" : ""}" data-act="go" data-i="${i}">${i + 1}</button>`;
    }).join("");

    const opts = card.order.map((orig, k) => {
      let cls = "";
      if (reveal) cls = orig === q.a ? "right" : chosen === orig ? "wrong" : "dim";
      else if (exam && chosen === orig) cls = "chosen";
      return `<li><button class="opt glass ${cls}" data-act="answer" data-o="${orig}" ${reveal ? "disabled" : ""}>
        <span class="key">${LETTERS[k]}</span><span>${esc(q.o[orig])}</span></button></li>`;
    }).join("");

    let why = "";
    if (reveal) {
      const ok = chosen === q.a;
      const text = q.s === "m" ? `Правильный ответ: ${esc(q.o[q.a])}.` : esc(q.w);
      why = `<div class="why glass ${ok ? "ok" : "bad"}"><b>${ok ? "Верно" : "Неверно"}</b><p>${text}</p>${q.r ? `<small>${esc(q.r)}</small>` : ""}</div>`;
    }

    const right = exam
      ? `<span class="r timer num" id="clock">${clock(Math.max(0, run.limit - (Date.now() - run.startedAt)))}</span>`
      : `<span class="r num">${run.i + 1}<span style="color:var(--dim);font-weight:700">/${run.cards.length}</span></span>`;

    let next;
    if (exam && (answered === run.cards.length || lastQ)) next = `<button class="btn acc" data-act="finish">Завершить · ${answered}/${run.cards.length}</button>`;
    else if (lastQ) next = `<button class="btn acc" data-act="finish">Итоги</button>`;
    else next = `<button class="btn prim" data-act="go" data-i="${run.i + 1}">${exam || chosen !== null ? "Далее" : "Пропустить"}</button>`;

    const fresh = run.fresh;
    run.fresh = false;
    root.innerHTML = `
      <div class="qtop"><div class="wrap qhud glass">
        <div class="qbar"><button class="x" data-act="leave">${exam ? "Закончить" : "‹ Выйти"}</button><span class="ttl">${esc(run.title)}</span>${right}</div>
        <div class="prog"><i style="width:${(answered / run.cards.length) * 100}%"></i></div>
        <nav class="chips" id="chips" aria-label="Номера вопросов">${chips}</nav>
      </div></div>
      <main class="qbody wrap ${fresh ? "enter" : ""}">
        <section class="qcard glass hud">
          <div class="qmeta"><span class="label">${esc(topicTitle(q.t))}</span>
            <button class="star ${S.fav.has(q.id) ? "on" : ""}" data-act="fav" aria-label="${S.fav.has(q.id) ? "Убрать из избранного" : "В избранное"}">${S.fav.has(q.id) ? ICON.starOn : ICON.starOff}</button>
          </div>
          <h2 class="qtext">${esc(q.q)}</h2>
          <div class="qsrc">${q.s === "m" ? '<span class="pill navy">Вопрос Минприроды</span>' : '<span class="pill or">Тренировочный</span>'}</div>
        </section>
        <ul class="opts">${opts}</ul>
        ${why}
      </main>
      <footer class="qfoot"><div class="wrap glass">
        <button class="btn sec" data-act="go" data-i="${run.i - 1}" ${run.i === 0 ? "disabled" : ""}>Назад</button>${next}
      </div></footer>`;

    const cur = document.querySelector(".chip.cur");
    const box = document.getElementById("chips");
    if (cur && box) box.scrollLeft = cur.offsetLeft - box.clientWidth / 2 + cur.clientWidth / 2;
  }

  function go(i) {
    if (!run) return;
    run.i = Math.max(0, Math.min(run.cards.length - 1, i));
    run.fresh = true;
    if (run.kind === "marathon") { S.mar = run.i; save("mar"); }
    quiz();
    window.scrollTo(0, 0);
  }

  function answer(o) {
    if (!run || run.done) return;
    const exam = run.kind === "exam";
    const card = run.cards[run.i];
    if (run.answers[run.i] !== null && !exam) return;
    const first = run.answers[run.i] === null;
    run.answers[run.i] = o;
    const ok = o === card.q.a;
    if (first) {
      S.ans[card.q.id] = ok ? "g" : "b";
      save("ans");
    }
    if (exam) {
      // На экзамене подсказок нет: отмечаем выбор и идём к следующему вопросу без ответа.
      haptic.tap();
      quiz();
      const nextFree = run.answers.findIndex((a, k) => a === null && k > run.i);
      const anyFree = nextFree >= 0 ? nextFree : run.answers.findIndex((a) => a === null);
      if (anyFree >= 0) setTimeout(() => run && run.kind === "exam" && !run.done && go(anyFree), 260);
    } else {
      ok ? haptic.ok() : haptic.bad();
      quiz();
      const w = document.querySelector(".why");
      if (w) w.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
    }
  }

  function leaveQuiz() {
    if (!run) return home();
    const answered = run.answers.some((a) => a !== null);
    if (run.kind === "exam") {
      if (!answered) return home();
      confirmBox("Завершить экзамен? Вопросы без ответа засчитаются как ошибки.", finish);
      return;
    }
    if (answered && run.kind !== "marathon") return finish();
    home();
  }

  function finish() {
    if (!run || run.done) return;
    run.done = true;
    stopTimer();
    if (can("6.2")) tg.disableClosingConfirmation();
    const total = run.cards.length;
    const correct = run.cards.filter((c, i) => run.answers[i] === c.q.a).length;
    const exam = run.kind === "exam";
    const need = Math.ceil(total * PASS);
    const passed = correct >= need;
    if (exam) {
      S.exams.unshift({ at: new Date().toISOString(), total, correct, passed });
      S.exams = S.exams.slice(0, 10);
      save("ex");
      passed ? haptic.ok() : haptic.bad();
    }
    // Марафон пройден до конца — в следующий раз начнём сначала.
    if (run.kind === "marathon" && run.i === total - 1) { S.mar = 0; save("mar"); }
    flush();
    result({ total, correct, need, passed, exam });
  }

  function confetti() {
    if (reduced) return;
    const box = document.createElement("div");
    box.className = "confetti";
    const colors = ["#eb5806", "#ff9047", "#2bd178", "#9cc8f0", "#ffffff", "#1a6fc0"];
    let html = "";
    for (let i = 0; i < 70; i++) {
      html += `<i style="left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-delay:${(Math.random() * 0.6).toFixed(2)}s;animation-duration:${(2.2 + Math.random() * 1.4).toFixed(2)}s;transform:rotate(${Math.round(Math.random() * 360)}deg)"></i>`;
    }
    box.innerHTML = html;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 4200);
  }

  function result(r) {
    setBack(home);
    const answered = run.answers.filter((a) => a !== null).length;
    const base = r.exam ? r.total : answered;
    const pct = base ? Math.round((r.correct / base) * 100) : 0;
    const wrong = run.cards.map((c, i) => ({ c, a: run.answers[i], n: i + 1 })).filter((x) => x.a !== x.c.q.a);
    const shownWrong = r.exam ? wrong : wrong.filter((x) => x.a !== null);
    const good = r.exam ? r.passed : pct >= 75;
    const head = r.exam
      ? `<h1 class="${r.passed ? "ok" : ""}">${r.passed ? "Экзамен сдан" : "Не сдан"}</h1><p>Верно <b class="num">${r.correct}</b> из ${r.total} · нужно ${r.need}</p><span class="pill ${r.passed ? "ok" : "bad"}">${r.passed ? "Готовы к проверке" : "Нужно ещё потренироваться"}</span>`
      : `<h1>Верно ${r.correct} из ${answered}</h1><p>${esc(run.title)}${answered < r.total ? ` · отвечено ${answered} из ${r.total}` : ""}</p>`;

    root.innerHTML = `
      <div class="wrap enter">
        <div class="top">${LOGO}</div><header class="hero res">${scope(pct, r.exam ? "Результат" : "Точность", good ? "ok" : "")}${head}</header>
        <main class="body">
          <div class="acts">
            ${shownWrong.length ? `<button class="btn acc wide" data-act="redo">Работа над ошибками · ${shownWrong.length}</button>` : ""}
            <button class="btn prim wide" data-act="again">${r.exam ? "Новый экзамен" : "Ещё раз"}</button>
            <button class="btn sec wide" data-act="home">На главную</button>
          </div>
          <div class="sect label">${shownWrong.length ? "Разбор ошибок" : "Ошибок нет"}</div>
          ${shownWrong.length ? shownWrong.map((x) => `
            <div class="mist glass"><span class="label">Вопрос ${x.n}</span><div class="mq">${esc(x.c.q.q)}</div>
              <div class="mb">${x.a !== null ? esc(x.c.q.o[x.a]) : "Нет ответа"}</div>
              <div class="ma">✓ ${esc(x.c.q.o[x.c.q.a])}</div></div>`).join("") : `<div class="glass empty">Все ответы верные — так держать.</div>`}
        </main>
        <footer class="foot">${LOGO}<div class="tag">Надёжность. Точность. Сделано в России.</div></footer>
      </div>`;
    run.wrongCards = shownWrong.map((x) => toCard(x.c.q));
    window.scrollTo(0, 0);
    if (r.exam && r.passed) confetti();
  }

  function toast(text) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  /* ───────── События ───────── */

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === "start") start(b.dataset.kind, b.dataset.topic);
    else if (act === "go") { haptic.tap(); go(+b.dataset.i); }
    else if (act === "answer") answer(+b.dataset.o);
    else if (act === "finish") {
      if (run && run.kind === "exam" && run.answers.some((a) => a === null)) confirmBox("Есть вопросы без ответа — они засчитаются как ошибки. Завершить?", finish);
      else finish();
    }
    else if (act === "leave") leaveQuiz();
    else if (act === "fav") {
      const id = run.cards[run.i].q.id;
      if (S.fav.has(id)) { S.fav.delete(id); toast("Убрано из избранного"); }
      else { S.fav.add(id); toast("Добавлено в избранное"); }
      haptic.tap();
      save("fav");
      quiz();
    }
    else if (act === "redo") start("redo", null, shuffle(run.wrongCards));
    else if (act === "again") {
      const k = run.kind, tp = run.cards[0] && run.cards[0].q.t;
      if (k === "redo") start("redo", null, shuffle(run.cards.map((c) => toCard(c.q))));
      else start(k, k === "topic" ? tp : null);
    }
    else if (act === "home") home();
    else if (act === "site") openSite();
    else if (act === "reset") confirmBox("Сбросить весь прогресс, избранное и историю экзаменов?", () => {
      S.ans = {}; S.fav = new Set(); S.exams = []; S.mar = 0;
      save("ans", "fav", "ex", "mar"); flush(); home(); toast("Прогресс сброшен");
    });
  });

  // Клавиатура на компьютере: 1–6 — вариант, ← → — вопросы.
  document.addEventListener("keydown", (e) => {
    if (!run || run.done || document.querySelector(".dlg")) return;
    if (e.key >= "1" && e.key <= "6") {
      const o = run.cards[run.i].order[+e.key - 1];
      if (o !== undefined) answer(o);
    } else if (e.key === "ArrowRight") go(run.i + 1);
    else if (e.key === "ArrowLeft") go(run.i - 1);
  });

  /* ───────── Запуск ───────── */

  root.innerHTML = '<div class="empty" style="padding-top:40vh">Загружаем…</div>';
  readAll().then((v) => { load(v); home(); });
})();

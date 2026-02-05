(() => {
  const DEFAULT_SETTINGS = {
    likes: { enabled: true, min: 1000, op: "ge" },
    reposts: { enabled: true, min: 200, op: "ge" },
    replies: { enabled: false, min: 50, op: "le" },
    views: { enabled: false, min: 50000, op: "ge" },
    suspect: { ratioLeft: 3, ratioRight: 1 },
    time: { enabled: false, value: 24, unit: "h", op: "le" }
  };

  const PROCESSED_ATTR = "data-viral-checked";
  const HIGHLIGHT_CLASS = "viral-highlight";
  const ENABLE_SUSPECT_FEATURE = false;
  const USER_PROCESSED_ATTR = "data-viral-user-checked";
  const USER_CELL_SELECTOR =
    '[data-testid="UserCell"], [data-testid="TypeaheadUser"], [data-testid="userCell"]';
  const NONFOLLOWER_CLASS = "viral-nonfollower";
  const SUSPECT_CLASS = "viral-suspect";
  const FOLLOW_BACK_LABELS = ["Follows you", "关注了你", "关注你", "关注了您"];

  let currentSettings = { ...DEFAULT_SETTINGS };
  let scanScheduled = false;
  const pendingRoots = new Set();
  const userStatsCache = new Map();

  function normalizeSettings(raw) {
    const normalized = {};
    const base = DEFAULT_SETTINGS;
    const src = raw || {};

    const normalizeMetric = (key) => {
      const value = src[key] || base[key];
      const minValue = Number(value.min);
      const op = value.op === "le" || value.op === "ge" ? value.op : base[key].op;
      normalized[key] = {
        enabled: Boolean(value.enabled),
        min: Number.isFinite(minValue) ? minValue : base[key].min,
        op
      };
    };

    normalizeMetric("likes");
    normalizeMetric("reposts");
    normalizeMetric("replies");
    normalizeMetric("views");

    const suspectSrc = src.suspect || base.suspect;
    const ratioLeftRaw =
      suspectSrc.ratioLeft !== undefined ? suspectSrc.ratioLeft : suspectSrc.ratio;
    const ratioRightRaw =
      suspectSrc.ratioRight !== undefined ? suspectSrc.ratioRight : 1;
    const ratioLeft = Number(ratioLeftRaw);
    const ratioRight = Number(ratioRightRaw);
    normalized.suspect = {
      ratioLeft: Number.isFinite(ratioLeft) ? ratioLeft : base.suspect.ratioLeft,
      ratioRight: Number.isFinite(ratioRight) ? ratioRight : base.suspect.ratioRight
    };

    const timeSrc = src.time || base.time;
    const timeValue = Number(timeSrc.value);
    const unit = timeSrc.unit === "min" || timeSrc.unit === "h" ? timeSrc.unit : base.time.unit;
    const timeOp = timeSrc.op === "le" || timeSrc.op === "ge" ? timeSrc.op : base.time.op;
    normalized.time = {
      enabled: Boolean(timeSrc.enabled),
      value: Number.isFinite(timeValue) ? timeValue : base.time.value,
      unit,
      op: timeOp
    };

    return normalized;
  }

  function parseAbbrevNumber(text) {
    if (!text) return 0;
    const t = text.replace(/,/g, "").trim();
    const match = t.match(/^([\d.]+)\s*([KMB]|万|億|亿)?$/i);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    if (Number.isNaN(value)) return 0;
    const suffix = match[2];
    if (!suffix) return Math.round(value);
    const upper = suffix.toUpperCase();
    if (upper === "K") return Math.round(value * 1e3);
    if (upper === "M") return Math.round(value * 1e6);
    if (upper === "B") return Math.round(value * 1e9);
    if (suffix === "万") return Math.round(value * 1e4);
    if (suffix === "亿" || suffix === "億") return Math.round(value * 1e8);
    return 0;
  }

  function parseFromAriaLabel(el) {
    if (!el) return 0;
    const label = el.getAttribute("aria-label") || "";
    const match = label.match(/[\d.,]+\s*(?:[KMB]|万|億|亿)?/i);
    if (!match) return 0;
    return parseAbbrevNumber(match[0]);
  }

  function parseCountFromText(text) {
    if (!text) return null;
    const match = text.match(/[\d.,]+\s*(?:[KMB]|万|億|亿)?/i);
    if (!match) return null;
    return parseAbbrevNumber(match[0]);
  }

  function parseCountFromLink(link) {
    if (!link) return null;
    const text = link.textContent || link.getAttribute("aria-label") || "";
    return parseCountFromText(text);
  }

  function getCountsFromContainer(container) {
    if (!container) return null;
    const followersLink = container.querySelector(
      'a[href$="/followers"], a[href*="/followers?"]'
    );
    const followingLink = container.querySelector(
      'a[href$="/following"], a[href*="/following?"]'
    );
    const followers = parseCountFromLink(followersLink);
    const following = parseCountFromLink(followingLink);
    if (followers === null || following === null) return null;
    return { followers, following };
  }

  function isFollowingListPage() {
    return /\/following\b/.test(window.location.pathname);
  }

  function isEligibleUserCell(cell) {
    if (!isFollowingListPage()) return false;
    const primaryColumn = cell.closest('[data-testid="primaryColumn"]');
    if (!primaryColumn) return false;
    if (cell.closest('aside[role="complementary"], [data-testid="sidebarColumn"]')) {
      return false;
    }
    if (!cell.closest('main[role="main"]')) return false;

    const followingTimeline = cell.closest(
      '[aria-label*="Timeline: Following"], [aria-label*="Timeline: 正在关注"], [aria-label*="正在关注"], [aria-label*="Following"]'
    );
    if (followingTimeline) return true;

    const selectedTab = primaryColumn.querySelector('[role="tab"][aria-selected="true"]');
    const tabText = (selectedTab && selectedTab.textContent) || "";
    if (tabText.includes("正在关注") || tabText.includes("Following")) {
      return true;
    }

    return false;
  }

  function getUsernameFromCell(cell) {
    const links = cell.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;
      if (href.startsWith("/i/")) continue;
      const path = href.split("?")[0];
      const parts = path.split("/").filter(Boolean);
      if (!parts.length) continue;
      if (parts.length > 1 && parts[1] === "status") continue;
      const username = parts[0];
      if (
        [
          "home",
          "search",
          "notifications",
          "messages",
          "explore",
          "settings",
          "compose",
          "login"
        ].includes(username)
      ) {
        continue;
      }
      return username;
    }
    return null;
  }

  function hasFollowBackIndicator(cell) {
    const indicator = cell.querySelector(
      '[data-testid="socialContext"], [data-testid="UserFollowIndicator"], [data-testid="userFollowIndicator"]'
    );
    const indicatorText =
      (indicator && (indicator.textContent || indicator.getAttribute("aria-label"))) || "";
    if (FOLLOW_BACK_LABELS.some((label) => indicatorText.includes(label))) {
      return true;
    }

    const ariaMatch = cell.querySelector(
      '[aria-label*="Follows you"], [aria-label*="关注了你"], [aria-label*="关注你"], [aria-label*="关注了您"]'
    );
    if (ariaMatch) return true;

    const spans = cell.querySelectorAll("span");
    for (const span of spans) {
      const text = (span.textContent || "").trim();
      if (FOLLOW_BACK_LABELS.includes(text)) return true;
    }

    return false;
  }

  function isSuspect(stats) {
    if (!stats) return false;
    const ratioLeft = Math.max(currentSettings.suspect.ratioLeft || 1, 1);
    const ratioRight = Math.max(currentSettings.suspect.ratioRight || 1, 1);
    const ratio = ratioLeft / ratioRight;
    const safeFollowing = Math.max(stats.following, 1);
    return stats.followers / safeFollowing >= ratio;
  }

  function getUserHighlightTarget(cell) {
    const wrapper = cell.closest(
      'div[data-testid="cellInnerDiv"], div[role="listitem"], li[role="listitem"]'
    );
    return wrapper || cell;
  }

  function applyUserHighlight(cell, suspect) {
    if (!isEligibleUserCell(cell)) return;
    const target = getUserHighlightTarget(cell);
    target.classList.remove(NONFOLLOWER_CLASS, SUSPECT_CLASS);
    target.classList.add(suspect ? SUSPECT_CLASS : NONFOLLOWER_CLASS);
    if (target !== cell) {
      cell.classList.remove(NONFOLLOWER_CLASS, SUSPECT_CLASS);
      cell.classList.add(suspect ? SUSPECT_CLASS : NONFOLLOWER_CLASS);
    }
  }

  function processUserCell(cell) {
    if (!cell || !(cell instanceof HTMLElement)) return;
    if (!isEligibleUserCell(cell)) return;
    if (cell.getAttribute(USER_PROCESSED_ATTR)) return;

    cell.setAttribute(USER_PROCESSED_ATTR, "1");

    if (hasFollowBackIndicator(cell)) return;

    const username = getUsernameFromCell(cell);
    if (username) {
      cell.setAttribute("data-viral-user", username);
    }

    let suspect = false;
    if (ENABLE_SUSPECT_FEATURE) {
      let stats = getCountsFromContainer(cell);
      if (!stats && username && userStatsCache.has(username)) {
        stats = userStatsCache.get(username);
      }
      suspect = Boolean(stats && isSuspect(stats));
    }

    applyUserHighlight(cell, suspect);
  }

  function scanUserCells(root = document) {
    if (!isFollowingListPage()) return;
    if (!root) return;
    if (root.matches && root.matches(USER_CELL_SELECTOR)) {
      processUserCell(root);
      return;
    }
    const cells = root.querySelectorAll(USER_CELL_SELECTOR);
    for (const cell of cells) {
      processUserCell(cell);
    }
  }

  function updateUserCellsForUsername(username) {
    if (!username) return;
    const safeName = window.CSS && CSS.escape ? CSS.escape(username) : username;
    const cells = document.querySelectorAll(
      `${USER_CELL_SELECTOR}[data-viral-user="${safeName}"]`
    );
    const stats = userStatsCache.get(username);
    const suspect = Boolean(stats && isSuspect(stats));
    for (const cell of cells) {
      if (hasFollowBackIndicator(cell)) continue;
      if (!isEligibleUserCell(cell)) continue;
      applyUserHighlight(cell, suspect);
    }
  }

  function maybeCacheStatsFromNode(node) {
    if (!node || !(node instanceof HTMLElement)) return;
    const container =
      node.matches && node.matches('[data-testid="HoverCard"]')
        ? node
        : node.querySelector && node.querySelector('[data-testid="HoverCard"]');
    if (!container) return;

    const stats = getCountsFromContainer(container);
    const username = getUsernameFromCell(container);
    if (!stats || !username) return;
    userStatsCache.set(username, stats);
    updateUserCellsForUsername(username);
  }
  function getMetricCount(tweetEl, metricName) {
    const testIdMap = {
      replies: "reply",
      reposts: "retweet",
      likes: "like"
    };

    if (metricName === "views") {
      const viewsTarget = tweetEl.querySelector(
        'a[href*="/analytics"], a[aria-label*=" views"], [aria-label*=" Views"]'
      );
      if (!viewsTarget) return 0;
      const span = viewsTarget.querySelector("span");
      if (span && span.textContent) {
        return parseAbbrevNumber(span.textContent);
      }
      return parseFromAriaLabel(viewsTarget);
    }

    const testId = testIdMap[metricName];
    if (!testId) return 0;
    const button = tweetEl.querySelector(`[data-testid="${testId}"]`);
    if (!button) return 0;

    const span = button.querySelector("span");
    if (span && span.textContent) {
      return parseAbbrevNumber(span.textContent);
    }

    return parseFromAriaLabel(button);
  }

  function getTweetTimestamp(tweetEl) {
    const timeEl = tweetEl.querySelector("time");
    if (!timeEl) return null;
    const datetime = timeEl.getAttribute("datetime");
    if (!datetime) return null;
    const ts = Date.parse(datetime);
    if (Number.isNaN(ts)) return null;
    return ts;
  }

  function compareValue(op, actual, threshold) {
    if (op === "le") return actual <= threshold;
    return actual >= threshold;
  }

  function isWithinTimeWindow(tweetEl) {
    if (!currentSettings.time.enabled) return true;
    const ts = getTweetTimestamp(tweetEl);
    if (!ts) return false;
    const now = Date.now();
    const diff = Math.max(0, now - ts);
    const unitMs = currentSettings.time.unit === "min" ? 60 * 1000 : 60 * 60 * 1000;
    const limit = currentSettings.time.value * unitMs;
    return compareValue(currentSettings.time.op, diff, limit);
  }

  function tweetMatches(tweetEl) {
    const s = currentSettings;
    const checks = [];

    if (s.likes.enabled) {
      const likes = getMetricCount(tweetEl, "likes");
      checks.push(compareValue(s.likes.op, likes, s.likes.min));
    }
    if (s.reposts.enabled) {
      const reposts = getMetricCount(tweetEl, "reposts");
      checks.push(compareValue(s.reposts.op, reposts, s.reposts.min));
    }
    if (s.replies.enabled) {
      const replies = getMetricCount(tweetEl, "replies");
      checks.push(compareValue(s.replies.op, replies, s.replies.min));
    }
    if (s.views.enabled) {
      const views = getMetricCount(tweetEl, "views");
      checks.push(compareValue(s.views.op, views, s.views.min));
    }
    if (s.time.enabled) {
      checks.push(isWithinTimeWindow(tweetEl));
    }

    if (!checks.length) return false;
    return checks.every(Boolean);
  }

  function highlightTweet(tweetEl) {
    const target = getHighlightTarget(tweetEl);
    target.classList.add(HIGHLIGHT_CLASS);
  }

  function getHighlightTarget(tweetEl) {
    const wrapper = tweetEl.closest('div[data-testid="cellInnerDiv"]');
    return wrapper || tweetEl;
  }

  function processTweet(tweetEl) {
    if (!tweetEl || !(tweetEl instanceof HTMLElement)) return;
    if (tweetEl.getAttribute(PROCESSED_ATTR)) return;

    tweetEl.setAttribute(PROCESSED_ATTR, "1");
    if (tweetMatches(tweetEl)) {
      highlightTweet(tweetEl);
    }
  }

  function scanTweets(root = document) {
    if (!root) return;
    if (root.matches && root.matches('article[data-testid="tweet"]')) {
      processTweet(root);
      return;
    }

    const tweets = root.querySelectorAll('article[data-testid="tweet"]');
    for (const tweet of tweets) {
      processTweet(tweet);
    }
  }

  function requestScan(root) {
    if (root) pendingRoots.add(root);
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      for (const r of roots) {
        scanTweets(r);
        scanUserCells(r);
        if (ENABLE_SUSPECT_FEATURE) {
          maybeCacheStatsFromNode(r);
        }
      }
    });
  }

  function initObserver() {
    const target = document.body;
    if (!target) return;

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement) {
            requestScan(node);
          }
        }
      }
    });

    observer.observe(target, { childList: true, subtree: true });
  }

  function reprocessAll() {
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    for (const tweet of tweets) {
      tweet.removeAttribute(PROCESSED_ATTR);
    }
    const highlighted = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    for (const node of highlighted) {
      node.classList.remove(HIGHLIGHT_CLASS);
    }
    const userCells = document.querySelectorAll(USER_CELL_SELECTOR);
    for (const cell of userCells) {
      cell.removeAttribute(USER_PROCESSED_ATTR);
      cell.removeAttribute("data-viral-user");
    }
    const userHighlights = document.querySelectorAll(
      `.${NONFOLLOWER_CLASS}, .${SUSPECT_CLASS}`
    );
    for (const node of userHighlights) {
      node.classList.remove(NONFOLLOWER_CLASS, SUSPECT_CLASS);
    }
    requestScan(document);
  }

  function loadSettings() {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.sync) {
        resolve(normalizeSettings(DEFAULT_SETTINGS));
        return;
      }
      chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
        resolve(normalizeSettings(items));
      });
    });
  }

  async function bootstrap() {
    currentSettings = await loadSettings();
    requestScan(document);
    initObserver();
  }

  bootstrap();

  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const key of Object.keys(changes)) {
        currentSettings[key] = normalizeSettings({ [key]: changes[key].newValue })[key];
      }
      reprocessAll();
    });
  }
})();

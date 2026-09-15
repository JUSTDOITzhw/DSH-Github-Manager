/**
 * dsh-github-manager — browser half.
 *
 * Contributes one action into the `sidebar.footer.action` slot: a GitHub badge
 * at the foot of the sidebar. Opening it renders a frame-wide panel with three
 * tabs — account, repositories, upload — which drive the host half's loopback
 * routes. The token never reaches this half; it only ever sees the login, the
 * avatar and the OAuth scopes.
 *
 * Also registers a `@` source into the composer's trigger registry, so a
 * repository can be referenced in the draft like a file or a session. Both
 * halves of the feature read the same host listing and the same credential.
 *
 * Packaged as a loader lazy-CJS factory product: the whole module body lives
 * inside the factory closure and runs at materialization. Only the
 * platform-seeded `react` module is required, so the bundle stays pure.
 *
 * Styling follows the same rules as the other in-tree panels: `--dsw-alias-*`
 * semantic aliases only, no colour literals, no theme branches.
 */
window.__ModuleLoader__.load({
  id: "dsh-github-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    const API = "/api/github-manager";
    /* Shown in the panel header: the client half is read once at dsh activation
     * and cached, so a restart is the only way to pick up an edit. Printing the
     * version makes "did my restart land?" a one-glance question. */
    const VERSION = "0.4.3";

    const TABS = [
      { id: "account", label: "账号" },
      { id: "repos", label: "仓库" },
      { id: "upload", label: "上传" },
    ];

    /* ------------------------------------------------------------------ *
     * Pure helpers (asserted directly by the smoke test)
     * ------------------------------------------------------------------ */

    /** Human-readable byte count; the panel shows sizes in three places. */
    function formatBytes(bytes) {
      const value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
      return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    /** GitHub hands back ISO-8601; the panel wants something scannable. */
    function formatWhen(iso, now) {
      if (typeof iso !== "string" || iso === "") return "";
      const then = Date.parse(iso);
      if (Number.isNaN(then)) return "";
      const at = typeof now === "number" ? now : Date.now();
      const seconds = Math.max(0, Math.round((at - then) / 1000));
      if (seconds < 60) return "刚刚";
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      const days = Math.round(hours / 24);
      if (days < 30) return `${days} 天前`;
      const months = Math.round(days / 30);
      if (months < 12) return `${months} 个月前`;
      return `${Math.round(months / 12)} 年前`;
    }

    function asText(value) {
      return typeof value === "string" ? value : "";
    }

    /**
     * The single text run of the sidebar badge. The footer row is shared with
     * dsh-cost-meter's balance card, so there is room for exactly one shrinkable
     * string; this picks the most useful one.
     *
     * @param bound - whether a credential is stored.
     * @param login - the account login, when one is known.
     * @returns `@login`, `已绑定`, or `GitHub`.
     */
    function badgeLabel(bound, login) {
      if (bound !== true) return "GitHub";
      return login === "" ? "已绑定" : `@${login}`;
    }

    /**
     * A repository row is only worth rendering when it can state what it is;
     * anything without a name is dropped rather than leaving a blank row.
     */
    function normalizeRepos(payload) {
      const list = Array.isArray(payload) ? payload : [];
      return list
        .map((item) => {
          const row = item !== null && typeof item === "object" ? item : {};
          const name = asText(row.name);
          const fullName = asText(row.fullName) || name;
          if (name === "" && fullName === "") return null;
          return {
            name: name === "" ? fullName : name,
            fullName,
            owner: asText(row.owner),
            private: row.private === true,
            description: asText(row.description),
            htmlUrl: asText(row.htmlUrl),
            defaultBranch: asText(row.defaultBranch) || "main",
            updatedAt: asText(row.updatedAt),
            size: typeof row.size === "number" ? row.size : 0,
            stars: typeof row.stars === "number" ? row.stars : 0,
          };
        })
        .filter((row) => row !== null);
    }

    /** Case-insensitive filter over name + description. */
    function filterRepos(repos, query) {
      const needle = asText(query).trim().toLowerCase();
      if (needle === "") return repos;
      return repos.filter((repo) =>
        `${repo.fullName} ${repo.description}`.toLowerCase().includes(needle));
    }

    /** OAuth scopes drive which buttons the panel offers. */
    function scopeHas(scopes, wanted) {
      if (!Array.isArray(scopes)) return false;
      return scopes.includes(wanted);
    }

    /** A PAT with no scope header still works; treat empty as "unknown, allow". */
    function canDelete(scopes) {
      if (!Array.isArray(scopes) || scopes.length === 0) return true;
      return scopeHas(scopes, "delete_repo");
    }

    /** The device flow answers with a small vocabulary of states. */
    function devicePhase(body) {
      if (body === null || typeof body !== "object") return "idle";
      if (asText(body.userCode) !== "") return "waiting";
      if (body.pending === true) return "pending";
      if (body.ok === true && body.account) return "done";
      return "idle";
    }

    /** Default remote path for a single-file upload: keep only the basename. */
    function remotePathFor(localPath) {
      const parts = asText(localPath).split(/[\\/]/).filter((part) => part !== "");
      return parts.length === 0 ? "" : parts[parts.length - 1];
    }

    /** basename of a local directory, used to prefill the repository name. */
    function baseName(path) {
      const parts = asText(path).split(/[\\/]/).filter((part) => part !== "");
      return parts.length === 0 ? "" : parts[parts.length - 1];
    }

    /* ------------------------------------------------------------------ *
     * The `@` composer source: reference one of your repositories
     *
     * The composer's `@` menu is a registry (`ctx.inputTriggers`) of sources
     * that each answer one keystroke with candidate rows. This half contributes
     * a fourth group beside the shell's files/sessions, its plugins and the
     * codex plugin's sketch entry: the bound account's repositories, filtered
     * locally out of one cached host listing.
     *
     * A picked row becomes an atomic chip in the draft. The chip carries two
     * projections — what the clipboard copies (`@owner/name`, plain text a
     * human reads) and what the model receives (a `<github-repo …>` element
     * whose attributes answer everything a tool call needs to aim at the
     * repository). The model form is what makes a mention worth more than
     * typing the name: it survives re-sending every turn and needs no lookup.
     * ------------------------------------------------------------------ */

    /** Menu group name; doubles as the codec routing key stamped on chips. */
    const AT_SOURCE = "github";
    /* The menu viewport is 320px tall; keep the list scannable. */
    const AT_MAX_ROWS = 30;
    /* Repositories change rarely inside one composing session; re-list lazily. */
    const AT_TTL_MS = 60 * 1000;
    /* A row's description is one line of a 440px menu; longer text is noise. */
    const AT_DESCRIPTION_MAX = 60;
    /* The scope words: typing one after `@` narrows the menu to repositories.
       Every other `@` group filters against the same text, finds nothing and
       drops out of the menu, so the list really does read as "only my repos".
       Longest first — `repos` must win over `repo`, `我的仓库` over `仓库`. */
    const AT_SCOPES = ["github", "repos", "我的仓库", "repo", "仓库", "gh"]
      .sort((left, right) => right.length - left.length);
    /* One separator ends the scope word: `@github/ue`, `@github:ue`, `@"github ue"`. */
    const AT_SEPARATOR = /^[\s/:]/;
    /* An alias at least this long also swallows a directly appended term:
       someone who typed `@github` and kept typing means `ue` as a filter, and a
       query the group cannot match would close the menu under their fingers.
       The short aliases do not — `@ghost` is a repository, not a scope. */
    const AT_STRIP_MIN = 4;
    /* The term echoed back in a heading is one line of a menu; clip it. */
    const AT_TERM_MAX = 24;
    /* Every row carries this heading, which is also what suppresses the menu's
       own group title — otherwise a row outside a listing (the bind prompt, the
       scope rescue) would show the raw source name `github` instead. */
    const AT_SECTION = "我的仓库";
    /* Sentinel candidate values. A repository reference is always `owner/name`,
       and GitHub forbids a leading `!` there, so these cannot collide. */
    const AT_ROW_PANEL = "!panel";
    const AT_ROW_SCOPE = "!scope";
    /* What the scope row writes into the draft, and the token the menu then
       lists under. The leading `@` matters: the pipeline replaces the whole
       trigger span with this text. */
    const AT_SCOPE_TEXT = "@github/";

    /** The `owner` half of an `owner/name` reference. */
    function ownerOf(fullName) {
      const text = asText(fullName);
      const cut = text.indexOf("/");
      return cut === -1 ? "" : text.slice(0, cut);
    }

    /** The `name` half of an `owner/name` reference. */
    function nameOf(fullName) {
      const text = asText(fullName);
      const cut = text.indexOf("/");
      return cut === -1 ? text : text.slice(cut + 1);
    }

    /** Attribute values come from a remote API; never emit unescaped markup. */
    function xmlAttr(value) {
      return xmlText(asText(value)).replace(/"/g, "&quot;");
    }

    /** Element text is escaped for the same reason attributes are. */
    function xmlText(value) {
      return asText(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    /** One menu row's description: what tells two similar repositories apart. */
    function repoSummary(repo) {
      const row = repo !== null && typeof repo === "object" ? repo : {};
      const bits = [row.private === true ? "私有" : "公开"];
      if (asText(row.defaultBranch) !== "") bits.push(`默认 ${asText(row.defaultBranch)}`);
      const description = asText(row.description);
      if (description !== "") {
        bits.push(description.length > AT_DESCRIPTION_MAX
          ? `${description.slice(0, AT_DESCRIPTION_MAX - 1)}…`
          : description);
      }
      const owner = asText(row.owner);
      return (owner === "" ? bits : [owner, ...bits]).join(" · ");
    }

    /** Clipboard / persistence projection of one repository reference. */
    function repoClipboardText(ref) {
      return `@${asText(ref)}`;
    }

    /**
     * Model projection of one repository reference: whatever the host listing
     * knew about the repository, spelled out so a tool call can target it with
     * no lookup round trip. Degrades to the bare path when the cache no longer
     * holds the row, because `owner/name` on its own is still actionable.
     */
    function repoSerialization(ref, repo) {
      const fullName = asText(ref);
      const row = repo !== null && typeof repo === "object" ? repo : {};
      const owner = asText(row.owner) !== "" ? asText(row.owner) : ownerOf(fullName);
      const name = asText(row.name) !== "" ? asText(row.name) : nameOf(fullName);
      const attrs = [`owner="${xmlAttr(owner)}"`, `name="${xmlAttr(name)}"`];
      if (typeof row.private === "boolean") attrs.push(`visibility="${row.private ? "private" : "public"}"`);
      if (asText(row.defaultBranch) !== "") attrs.push(`default_branch="${xmlAttr(row.defaultBranch)}"`);
      if (asText(row.htmlUrl) !== "") attrs.push(`url="${xmlAttr(row.htmlUrl)}"`);
      return `<github-repo ${attrs.join(" ")}>${xmlText(fullName)}</github-repo>`;
    }

    /**
     * Split a live `@` query into "is this the repository scope" and the term
     * to filter on.
     *
     * `@github`, `@github/`, `@gh/`, `@repos/`, `@仓库/` all mean "my
     * repositories, all of them"; whatever follows the separator is the filter.
     * Long aliases additionally swallow a directly appended term, because a
     * user who typed `@github` and kept typing is refining — and a query the
     * group cannot match would leave every group empty, which closes the whole
     * menu mid-keystroke.
     *
     * @param query - the text between `@` and the caret.
     * @returns `{ scoped, term }`; `term` is "" while the scope is bare.
     */
    function parseRepoQuery(query) {
      const text = asText(query).trim();
      if (text === "") return { scoped: false, term: "" };
      const lowered = text.toLowerCase();
      for (const alias of AT_SCOPES) {
        if (lowered.startsWith(alias) !== true) continue;
        const rest = text.slice(alias.length);
        if (rest === "" || AT_SEPARATOR.test(rest) === true) {
          return { scoped: true, term: rest.replace(/^[\s/:]+/, "").trim() };
        }
        if (alias.length >= AT_STRIP_MIN) return { scoped: true, term: rest.trim() };
      }
      return { scoped: false, term: text };
    }

    /**
     * One heading above the rows: which scope, which filter, how much of it is
     * on screen. A truncated list says so rather than counting rows the user
     * cannot reach.
     *
     * @param scope - the parsed query (`{ scoped, term }`).
     * @param shown - rows actually rendered.
     * @param matched - rows the filter kept (ignored when unscoped).
     * @param total - repositories the account has.
     * @returns the section title for every row of this listing.
     */
    function repoSection(scope, shown, matched, total) {
      const clipped = scope.term.length > AT_TERM_MAX ? `${scope.term.slice(0, AT_TERM_MAX - 1)}…` : scope.term;
      const head = scope.scoped === true && scope.term !== "" ? `${AT_SECTION} · 匹配“${clipped}”` : AT_SECTION;
      const count = scope.scoped === true && scope.term !== "" ? matched : total;
      if (count <= shown) return `${head} · ${scope.scoped === true && scope.term === "" ? "全部 " : ""}${count} 个`;
      return `${head} · 显示前 ${shown} 个（共 ${count}）`;
    }

    /**
     * Build the `@` source over one host listing.
     *
     * Every failure mode degrades to "fewer rows", never to a rejected promise:
     * the trigger pipeline drops a source whose `candidates` rejects, which
     * would delete the group from the menu and read as a broken plugin. An
     * unbound account, a sleeping host half and an aborted keystroke all keep
     * the group alive and explain themselves in a row.
     *
     * @param options.listRepos - posts `repos.list` to the host half.
     * @param options.openPanel - raises the sidebar panel (the bind path).
     * @param options.now - clock; injected so the cache is testable.
     * @returns the source object registered into `ctx.inputTriggers`.
     */
    function createRepoSource(options) {
      const listRepos = options.listRepos;
      const openPanel = options.openPanel;
      const now = typeof options.now === "function" ? options.now : () => Date.now();
      let cache = { at: 0, loaded: false, rows: [], notice: "" };
      let inflight = null;

      /** One host round trip at a time: a prewarm and a keystroke share it. */
      function fetchOnce() {
        if (inflight !== null) return inflight;
        inflight = Promise.resolve()
          .then(() => listRepos())
          .then((answer) => {
            const answer_ = answer !== null && typeof answer === "object" ? answer : {};
            const body = answer_.body !== null && typeof answer_.body === "object" ? answer_.body : {};
            if (answer_.status === 401) return { at: now(), loaded: true, rows: [], notice: "未绑定 GitHub 账号" };
            if (answer_.ok !== true) return { at: now(), loaded: true, rows: [], notice: asText(body.message) || "仓库列表不可用" };
            return { at: now(), loaded: true, rows: normalizeRepos(body.repos), notice: "" };
          })
          .catch(() => ({ at: now(), loaded: true, rows: [], notice: "无法连接宿主" }))
          .then((next) => {
            inflight = null;
            cache = next;
            return next;
          });
        return inflight;
      }

      /** Freshness is a loaded flag plus a window: "never loaded" is not "fresh",
       *  which a bare `now - at < ttl` test would report for a zero clock. */
      function snapshot() {
        return cache.loaded === true && now() - cache.at < AT_TTL_MS ? Promise.resolve(cache) : fetchOnce();
      }

      /** An empty list still has to say why it is empty — never a blank menu.
       *  The row is a prompt: picking it raises the panel, which is the fix. */
      function noticeRow(notice) {
        return {
          name: notice === "" ? "这个账号下还没有仓库" : notice,
          description: "选中即打开 GitHub 面板",
          section: AT_SECTION,
          value: AT_ROW_PANEL,
        };
      }

      /** One repository row; `section` is the heading the menu renders once. */
      function repoRow(repo, section) {
        return {
          name: repo.name,
          description: repoSummary(repo),
          section,
          value: repo.fullName,
        };
      }

      /**
       * The dead end that is also the way out: the query matched none of the
       * repositories, so the row offers the scope instead — Tab or Enter
       * rewrites the token to `@github/` and the menu lists every repository
       * again, with the alias spelled out for next time.
       */
      function scopeRow(total) {
        return {
          name: AT_SOURCE,
          description: `按仓库筛选 · 共 ${total} 个`,
          section: AT_SECTION,
          value: AT_ROW_SCOPE,
          drill: true,
        };
      }

      /** Scoped, and the term still matches nothing: say so, keep the menu up. */
      function missRow(term, total) {
        const clipped = asText(term).length > AT_TERM_MAX ? `${asText(term).slice(0, AT_TERM_MAX - 1)}…` : asText(term);
        return {
          name: `没有匹配“${clipped}”的仓库`,
          description: `共 ${total} 个 · 删掉筛选词可看全部`,
          section: AT_SECTION,
          value: "",
        };
      }

      return {
        trigger: "@",
        name: AT_SOURCE,
        /* Beside the shell's own groups rather than ahead of them. */
        order: 2,
        /* Scope birth asks for the listing, so the first `@` is already warm. */
        warm() {
          snapshot();
        },
        async candidates(_session, request) {
          const signal = request !== undefined && request !== null ? request.signal : undefined;
          const scope = parseRepoQuery(request !== undefined && request !== null ? request.query : undefined);
          /* `@"…"` is the quoted file-path form and belongs to the file group —
             unless the quoted text is one of our scope words, which is how
             `@"github ue"` reaches us (an unquoted `@` token cannot hold a space). */
          if (request?.quoted === true && scope.scoped !== true) return [];
          const listing = await snapshot();
          if (signal !== undefined && signal.aborted === true) return [];
          if (listing.rows.length === 0) return [noticeRow(listing.notice)];
          const matched = filterRepos(listing.rows, scope.term);
          if (matched.length === 0) {
            return [scope.scoped === true
              ? missRow(scope.term, listing.rows.length)
              : scopeRow(listing.rows.length)];
          }
          const shown = matched.slice(0, AT_MAX_ROWS);
          const section = repoSection(scope, shown.length, matched.length, listing.rows.length);
          return shown.map((repo) => repoRow(repo, section));
        },
        onPick(pick) {
          const value = asText(pick !== null && pick !== undefined && pick.candidate ? pick.candidate.value : "");
          /* The bind prompt: raise the panel the row promised. */
          if (value === AT_ROW_PANEL) {
            openPanel();
            /* Clear the half-typed token: that row was a prompt, not a mention. */
            return { text: "" };
          }
          /* The scope row descends the way a folder row does — `continue` keeps
             the menu open, so the next keystroke filters instead of closing. */
          if (value === AT_ROW_SCOPE) return { text: AT_SCOPE_TEXT, continue: true };
          /* An informational row (no match, host down): leaves no reference. */
          if (value === "") return { text: "" };
          return { insert: {
            source: AT_SOURCE,
            ref: value,
            label: value,
            clipboardText: repoClipboardText(value),
          } };
        },
        codec: {
          clipboardText: (ref) => repoClipboardText(ref),
          serialize: (ref) => {
            const fullName = asText(ref);
            return Promise.resolve(repoSerialization(fullName, cache.rows.find((row) => row.fullName === fullName)));
          },
        },
      };
    }

    /** The sidebar panel's open flag lives in Badge's own state; the `@` source
     *  has to raise it from outside React (the unbound-account row), so it rides
     *  a one-listener emitter instead of a store dependency. */
    const panelBus = {
      listeners: new Set(),
      open() {
        for (const listener of Array.from(panelBus.listeners)) {
          try {
            listener();
          } catch (error) {
            /* A disposed subscriber must not eat the pick. */
          }
        }
      },
    };

    /**
     * Mount the `@` source. `inputTriggers` belongs to the GUI shell rather than
     * to this plugin, so the registration waits for the service instead of
     * hard-injecting it: the sidebar panel has to keep working in any host where
     * the composer does not exist.
     */
    function attachRepoSource(ctx) {
      /* Register into one scope; true = the group is live. */
      const attempt = (scope) => {
        const triggers = typeof scope.get === "function" ? scope.get("inputTriggers") : undefined;
        if (triggers === undefined || triggers === null) return false;
        const source = createRepoSource({
          listRepos: () => post("repos.list"),
          openPanel: () => panelBus.open(),
        });
        scope.effect(() => triggers.registerSource(source), "dsh-github-manager: @ source");
        return true;
      };
      const guard = (run, note) => {
        try {
          return run();
        } catch (error) {
          console.warn(`[dsh-github-manager] ${note}:`, error);
          return false;
        }
      };
      /* The composer group is a bonus; the sidebar panel is the product. Neither
       * a throwing service lookup nor a host that refuses plugin creation may
       * cost the badge, so every step is guarded. */
      if (guard(() => attempt(ctx), "@ source unavailable") === true) return;
      guard(() => {
        if (typeof ctx.inject === "function") {
          ctx.inject(["inputTriggers"], (scope) => {
            guard(() => attempt(scope), "@ source unavailable");
          });
        }
      }, "@ trigger service unavailable");
    }

    /* ------------------------------------------------------------------ *
     * Host transport
     * ------------------------------------------------------------------ */

    async function getState() {
      try {
        const response = await fetch(`${API}/state`, { headers: { accept: "application/json" } });
        const body = await response.json();
        return body !== null && typeof body === "object" ? body : { ok: false, bound: false };
      } catch (error) {
        return { ok: false, bound: false, message: `无法连接宿主：${error && error.message ? error.message : String(error)}` };
      }
    }

    async function post(action, payload) {
      const request = { action, ...(payload === undefined ? {} : payload) };
      try {
        const response = await fetch(`${API}/action`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        const body = await response.json();
        const shaped = body !== null && typeof body === "object" ? body : { ok: false, message: `HTTP ${response.status}` };
        return { status: response.status, ok: shaped.ok === true, body: shaped };
      } catch (error) {
        return {
          status: 0,
          ok: false,
          body: { ok: false, message: `请求失败：${error && error.message ? error.message : String(error)}` },
        };
      }
    }

    /* ------------------------------------------------------------------ *
     * Styling
     * ------------------------------------------------------------------ */
    /* `sidebar.footer.action` is a `kind:list` slot whose occupants are packed
     * into one flex row. Every shipped occupant — the Cordis panel button and
     * dsh-cost-meter's balance stack — is a full-width (`width:100%`) block,
     * which is the tell that the row is really a vertical stack of lines that
     * happens to be laid out horizontally. Two such blocks cannot both be full
     * width on one line, and the shell clips the column
     * (`.sidebarCol{overflow:hidden}`): measured on a 280px sidebar, the
     * balance card was squeezed to 154px of the 256px line while this badge
     * overhung it by 142px and lost its right half off the edge of the column.
     *
     * So the row is folded into a column (see `foldFooterRow`), and this badge
     * is registered with the highest `order` in the slot: the badge then owns
     * the last line, sitting immediately above Settings, with every other
     * plugin's action stacked above it. The wide variant is therefore a
     * full-width 42px row shaped like the Settings row it stands next to, and
     * the label only has to ellipsize for narrow columns. The rail variant stays
     * icon-sized: a 56px rail minus its 10px padding leaves 36px.
     *
     * The row to fold is *not* `parentElement`. The shell wraps every occupant
     * of a list slot in a `display:contents` element, which generates no box at
     * all, so its children are laid out by the nearest ancestor that does have
     * one. Writing `flex-direction` to that wrapper is a silent no-op — the
     * measured row stayed `row` — which is what `findActionRow` exists to
     * avoid.
     *
     * Which line is ours is decided by `order` on our own node rather than by
     * the `order` handed to `register`: the shell's list renderer does not
     * reorder reliably (measured across two live runs of the same build, our
     * node came first once and last once, following registration timing), while
     * a flex `order` in our own stylesheet is deterministic. Ours is the last
     * line, so it always lands directly above Settings. */

    const CSS = `
.dsh-gm-badge{width:100%;max-width:100%;min-width:0;height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:0;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}
.dsh-gm-badge:hover,.dsh-gm-badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-gm-badgeLabel{flex:0 1 auto;text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.dsh-gm-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-caption)}
.dsh-gm-layer{flex:0 0 auto;min-width:0;max-width:100%;align-items:center;width:100%;height:42px;margin:0;display:flex;position:relative;order:999}
.dsh-gm-layer.dsh-gm-rail{flex:0 0 auto;width:16px;max-width:16px;height:36px;margin:0}
.dsh-gm-rail .dsh-gm-badge{corner-shape:round;border-radius:6px;justify-content:center;gap:0;width:16px;height:36px;padding:0;margin:0}
.dsh-gm-rail .dsh-gm-dot{position:absolute;top:2px;right:0;width:6px;height:6px}
.dsh-gm-panel{z-index:40;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:440px;max-width:calc(100vw - 24px);max-height:min(70vh,620px);box-shadow:var(--dsw-elevation-prominent);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;border-radius:12px;flex-direction:column;display:flex;position:fixed;overflow:hidden}
.dsh-gm-header{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;min-height:44px;gap:8px;padding:10px 12px;display:flex}
.dsh-gm-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px;display:flex;align-items:center;gap:8px;min-width:0}
.dsh-gm-version{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.dsh-gm-x{corner-shape:round;width:26px;height:26px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;display:inline-flex;flex:none;font-size:16px;line-height:1}
.dsh-gm-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-gm-tabs{flex:none;display:flex;gap:2px;padding:0 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-gm-tab{color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xs-13);background:0 0;border:0;padding:0 10px;height:32px;position:relative}
.dsh-gm-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-gm-tab[data-active]{color:var(--dsw-alias-state-business-primary)}
.dsh-gm-tab[data-active]:after{background:var(--dsw-alias-state-business-primary);content:"";border-radius:1px 1px 0 0;height:2px;position:absolute;bottom:0;left:10px;right:10px}
.dsh-gm-body{flex:1;min-height:0;padding:12px;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
.dsh-gm-field{display:flex;flex-direction:column;gap:5px}
.dsh-gm-label{color:var(--dsw-alias-label-caption);font-size:11px;font-weight:500;line-height:16px;text-transform:uppercase;letter-spacing:.04em}
.dsh-gm-input,.dsh-gm-select{border:.5px solid var(--dsw-alias-border-l3);box-sizing:border-box;width:100%;height:30px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);background:var(--dsw-alias-bg-base);border-radius:8px;padding:0 9px}
.dsh-gm-input:focus,.dsh-gm-select:focus{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}
.dsh-gm-input[data-mono]{font-family:var(--dsh-font-mono,monospace);font-size:12px}
.dsh-gm-row{display:flex;gap:8px;align-items:center}
.dsh-gm-rowwrap{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}
.dsh-gm-btn{corner-shape:round;border:.5px solid var(--dsw-alias-border-l3);height:28px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);cursor:pointer;background:0 0;border-radius:999px;align-items:center;justify-content:center;gap:6px;padding:0 12px;display:inline-flex;flex:none}
.dsh-gm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-gm-btn:disabled{opacity:.45;cursor:default}
.dsh-gm-btn[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.dsh-gm-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-inverted)}
.dsh-gm-btn[data-variant=danger]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l4)}
.dsh-gm-btn[data-variant=danger]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-gm-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-gm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-gm-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-gm-card{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dsh-gm-avatar{width:34px;height:34px;border-radius:50%;flex:none;object-fit:cover;background:var(--dsw-alias-interactive-bg-hover)}
.dsh-gm-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dsh-gm-item{border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;flex:0 0 auto}
.dsh-gm-itemHead{display:flex;align-items:center;gap:8px;min-height:22px}
.dsh-gm-itemName{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dsh-gm-itemName a{color:inherit;text-decoration:none}
.dsh-gm-itemName a:hover{text-decoration:underline}
.dsh-gm-tag{background:var(--dsw-alias-button-ghost-active-fill);height:18px;color:var(--dsw-alias-label-caption);border-radius:9px;flex:none;align-items:center;padding:0 6px;font-size:11px;line-height:18px;display:inline-flex}
.dsh-gm-tag[data-private]{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label)}
.dsh-gm-itemMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;display:flex;gap:8px;flex-wrap:wrap}
.dsh-gm-itemActions{display:flex;gap:8px;align-items:center;margin-top:2px}
.dsh-gm-code{font-family:var(--dsh-font-mono,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:8px;padding:6px 9px;user-select:all;overflow-wrap:anywhere}
.dsh-gm-browse{max-height:190px;overflow:auto;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;display:flex;flex-direction:column}
.dsh-gm-browseRow{cursor:pointer;border:0;background:0 0;text-align:left;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);padding:5px 9px;display:flex;gap:8px;align-items:center;flex:0 0 auto}
.dsh-gm-browseRow:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-gm-browseRow[data-kind=dir]{font-weight:500}
.dsh-gm-browseHead{border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-caption);font-size:11px;padding:5px 9px;display:flex;justify-content:space-between;gap:8px;position:sticky;top:0;background:var(--dsw-specific-menu)}
.dsh-gm-split{display:flex;gap:6px}
.dsh-gm-split .dsh-gm-btn{flex:1}
`;

    function ensureStyle() {
      if (typeof document === "undefined") return;
      const tagId = "dsh-github-manager/panel.css";
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-github-manager";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------ *
     * Small components
     * ------------------------------------------------------------------ */

    function GitHubMark(props) {
      const size = typeof props.size === "number" ? props.size : 16;
      return h("svg",
        { viewBox: "0 0 16 16", width: size, height: size, fill: "currentColor", "aria-hidden": "true", focusable: "false" },
        h("path", {
          d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z",
        }));
    }

    function Button(props) {
      return h("button", {
        type: "button",
        className: "dsh-gm-btn",
        "data-variant": props.variant,
        disabled: props.disabled === true,
        title: props.title ?? props.children,
        onClick: props.onClick,
      }, props.children);
    }

    function Field(props) {
      return h("div", { className: "dsh-gm-field" },
        props.label !== undefined ? h("div", { className: "dsh-gm-label" }, props.label) : null,
        props.children,
        props.hint !== undefined ? h("div", { className: "dsh-gm-note" }, props.hint) : null);
    }

    /* ------------------------------------------------------------------ *
     * Account tab
     * ------------------------------------------------------------------ */

    /**
     * One line describing whether the chat tools are live. A pure function so
     * the panel and the tests agree on every state the host can report.
     */
    function mcpSummary(mcp) {
      const info = mcp !== null && typeof mcp === "object" ? mcp : {};
      const name = asText(info.serverName) || "github";
      switch (asText(info.state)) {
        case "disabled":
          return "聊天工具已关闭（配置 enableMcp: false）";
        case "unbound":
          return `绑定账号后，聊天里会出现 mcp__${name}__* 工具`;
        case "mounted":
          return `聊天工具已挂载：mcp__${name}__*（${asText(info.toolsets) || "默认工具集"}）`;
        case "missing":
          return `聊天工具未启动：${asText(info.message) || "缺少 @deepseek-ai/dsh-mcp-client"}`;
        case "error":
          return `聊天工具启动失败：${asText(info.message) || "未知原因"}`;
        default:
          return "聊天工具：准备中…";
      }
    }

    function AccountTab(props) {
      const state = props.state;
      const account = state.account ?? null;
      const [token, setToken] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [clientId, setClientId] = React.useState(asText(state.deviceClientId));
      const [device, setDevice] = React.useState(null);

      const bound = state.bound === true;

      const bind = async () => {
        setBusy(true);
        setError("");
        const result = await post("auth.set", { token });
        setBusy(false);
        if (!result.ok) {
          setError(asText(result.body.message) || "绑定失败");
          return;
        }
        setToken("");
        props.refresh();
      };

      const unbind = async () => {
        setBusy(true);
        const result = await post("auth.clear");
        setBusy(false);
        if (!result.ok) setError(asText(result.body.message) || "解绑失败");
        setDevice(null);
        props.refresh();
      };

      const startDevice = async () => {
        setBusy(true);
        setError("");
        const result = await post("auth.device.start", { clientId });
        setBusy(false);
        if (!result.ok) {
          setError(asText(result.body.message) || "启动设备流失败");
          return;
        }
        setDevice({
          clientId: asText(result.body.clientId),
          userCode: asText(result.body.userCode),
          deviceCode: asText(result.body.deviceCode),
          verificationUri: asText(result.body.verificationUri),
          interval: typeof result.body.interval === "number" ? result.body.interval : 5,
        });
      };

      /* Poll until the user finishes in the browser. The interval is whatever
         GitHub asked for; a `slow_down` answer means it wants more room. */
      React.useEffect(() => {
        if (device === null) return undefined;
        let stopped = false;
        let timer = null;
        let wait = Math.max(3, device.interval) * 1000;
        const tick = async () => {
          if (stopped) return;
          const result = await post("auth.device.poll", { clientId: device.clientId, deviceCode: device.deviceCode });
          if (stopped) return;
          if (result.ok && result.body.pending !== true) {
            setDevice(null);
            props.refresh();
            return;
          }
          if (!result.ok) {
            setError(asText(result.body.message) || "授权失败");
            setDevice(null);
            return;
          }
          if (result.body.slowDown === true) wait += 5000;
          timer = setTimeout(tick, wait);
        };
        timer = setTimeout(tick, wait);
        return () => {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [device]);

      if (bound) {
        return h(React.Fragment, null,
          h("div", { className: "dsh-gm-card" },
            h("div", { className: "dsh-gm-row" },
              account !== null && asText(account.avatarUrl) !== ""
                ? h("img", { className: "dsh-gm-avatar", src: asText(account.avatarUrl), alt: "" })
                : h("div", { className: "dsh-gm-avatar" }),
              h("div", { style: { minWidth: 0, flex: 1 } },
                h("div", { className: "dsh-gm-itemName" }, asText(account?.name) || asText(account?.login) || "已绑定"),
                h("div", { className: "dsh-gm-itemMeta" },
                  h("span", null, `@${asText(account?.login) || "?"}`),
                  h("span", null, state.source === "device" ? "设备流授权" : "Personal Access Token"),
                  asText(state.savedAt) !== "" ? h("span", null, `绑定于 ${formatWhen(state.savedAt)}`) : null))),
            Array.isArray(account?.scopes) && account.scopes.length > 0
              ? h("div", { className: "dsh-gm-itemMeta" }, h("span", null, `权限：${account.scopes.join(", ")}`))
              : h("div", { className: "dsh-gm-note" }, "GitHub 未返回权限列表（fine-grained token 通常如此）"),
            canDelete(account?.scopes) === false
              ? h("div", { className: "dsh-gm-note" }, "缺少 delete_repo 权限：可以创建和上传，但不能删除仓库。")
              : null,
            h("div", { className: "dsh-gm-row" },
              h(Button, { onClick: props.refresh, disabled: busy }, "重新校验"),
              h(Button, { variant: "danger", onClick: unbind, disabled: busy }, "解除绑定"))),
          h("div", { className: "dsh-gm-note" }, `凭据保存在 ${asText(state.authPath)}（仅本机可读）`),
          /* The chat tools are mounted by the host half and share this plugin's
             lifecycle, so the panel only has to report what it observes. */
          h("div", { className: "dsh-gm-note" }, mcpSummary(state.mcp)),
          error !== "" ? h("div", { className: "dsh-gm-error" }, error) : null);
      }

      return h(React.Fragment, null,
        h("div", { className: "dsh-gm-card" },
          h(Field, {
            label: "Personal Access Token",
            hint: "在 github.com/settings/tokens 生成。需要 repo；要删除仓库再勾 delete_repo；要推工作流文件再勾 workflow。",
          },
            h("input", {
              className: "dsh-gm-input",
              "data-mono": true,
              type: "password",
              placeholder: "ghp_… 或 github_pat_…",
              value: token,
              onChange: (event) => setToken(event.target.value),
              onKeyDown: (event) => {
                if (event.key === "Enter" && token !== "" && busy === false) bind();
              },
            })),
          h("div", { className: "dsh-gm-row" },
            h(Button, { variant: "primary", onClick: bind, disabled: busy || token.trim() === "" }, busy ? "校验中…" : "绑定"))),

        h("div", { className: "dsh-gm-card" },
          h(Field, {
            label: "OAuth App client id",
            hint: "设备流需要一个 OAuth App 的 client id（github.com/settings/developers 新建，回调地址随便填）。",
          },
            h("input", {
              className: "dsh-gm-input",
              "data-mono": true,
              placeholder: "Iv1.… 或 Ov23li…",
              value: clientId,
              onChange: (event) => setClientId(event.target.value),
            })),
          device === null
            ? h("div", { className: "dsh-gm-row" },
                h(Button, { onClick: startDevice, disabled: busy || clientId.trim() === "" }, "用设备码授权"))
            : h("div", { className: "dsh-gm-field" },
                h("div", { className: "dsh-gm-note" }, "在浏览器里打开下面的地址，输入这个代码："),
                h("div", { className: "dsh-gm-code" }, device.userCode),
                h("div", { className: "dsh-gm-row" },
                  h("a", { className: "dsh-gm-btn", href: device.verificationUri, target: "_blank", rel: "noreferrer" }, "打开授权页"),
                  h(Button, { onClick: () => setDevice(null) }, "取消")),
                h("div", { className: "dsh-gm-note" }, "正在等待授权…（会自动完成）"))),

        h("div", { className: "dsh-gm-note" }, mcpSummary(state.mcp)),
        error !== "" ? h("div", { className: "dsh-gm-error" }, error) : null);
    }

    /* ------------------------------------------------------------------ *
     * Repositories tab
     * ------------------------------------------------------------------ */

    function RepoTab(props) {
      const account = props.account;
      const [repos, setRepos] = React.useState(null);
      const [query, setQuery] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [status, setStatus] = React.useState("");
      const [creating, setCreating] = React.useState(false);
      const [draft, setDraft] = React.useState({ name: "", description: "", private: true });
      const [pendingDelete, setPendingDelete] = React.useState(null);
      const [confirmText, setConfirmText] = React.useState("");

      const load = React.useCallback(async () => {
        setBusy(true);
        setError("");
        const result = await post("repos.list", { perPage: 100 });
        setBusy(false);
        if (!result.ok) {
          setError(asText(result.body.message) || "读取仓库失败");
          setRepos([]);
          return;
        }
        setRepos(normalizeRepos(result.body.repos));
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const create = async () => {
        setBusy(true);
        setError("");
        const result = await post("repos.create", {
          name: draft.name.trim(),
          description: draft.description,
          private: draft.private,
        });
        setBusy(false);
        if (!result.ok) {
          setError(asText(result.body.message) || "创建失败");
          return;
        }
        setCreating(false);
        setDraft({ name: "", description: "", private: true });
        setStatus(`已创建 ${asText(result.body.repo?.fullName)}`);
        load();
      };

      const toggleVisibility = async (repo) => {
        setBusy(true);
        setError("");
        const result = await post("repos.visibility", {
          owner: repo.owner,
          repo: repo.name,
          private: repo.private === false,
        });
        setBusy(false);
        if (!result.ok) {
          setError(asText(result.body.message) || "切换可见性失败");
          return;
        }
        load();
      };

      const remove = async (repo) => {
        setBusy(true);
        setError("");
        const result = await post("repos.delete", {
          owner: repo.owner,
          repo: repo.name,
          confirm: confirmText.trim(),
        });
        setBusy(false);
        if (!result.ok) {
          setError(asText(result.body.message) || "删除失败");
          return;
        }
        setPendingDelete(null);
        setConfirmText("");
        setStatus(`已删除 ${repo.fullName}`);
        load();
      };

      const shown = filterRepos(repos ?? [], query);

      /* One row: it either asks for the delete confirmation or offers the row's
         actions, never both. Kept as a local function because the render tree is
         built with h() calls, and inlining this would nest ten levels deep in a
         single expression. */
      const renderRepo = (repo) => {
        const confirming = pendingDelete !== null && pendingDelete.fullName === repo.fullName;
        return h("li", { className: "dsh-gm-item", key: repo.fullName },
          h("div", { className: "dsh-gm-itemHead" },
            h("span", { className: "dsh-gm-itemName" },
              repo.htmlUrl === ""
                ? repo.fullName
                : h("a", { href: repo.htmlUrl, target: "_blank", rel: "noreferrer" }, repo.fullName)),
            h("span", { className: "dsh-gm-tag", "data-private": repo.private ? "" : undefined },
              repo.private ? "私有" : "公开")),
          h("div", { className: "dsh-gm-itemMeta" },
            repo.updatedAt !== "" ? h("span", null, `更新于 ${formatWhen(repo.updatedAt)}`) : null,
            h("span", null, repo.defaultBranch),
            repo.description !== "" ? h("span", null, repo.description.slice(0, 60)) : null),
          confirming
            ? h("div", { className: "dsh-gm-field" },
                h("div", { className: "dsh-gm-error" }, `删除不可撤销。请输入 ${repo.fullName} 确认：`),
                h("input", {
                  className: "dsh-gm-input",
                  "data-mono": true,
                  value: confirmText,
                  onChange: (event) => setConfirmText(event.target.value),
                }),
                h("div", { className: "dsh-gm-row" },
                  h(Button, {
                    variant: "danger",
                    onClick: () => remove(repo),
                    disabled: busy || confirmText.trim() !== repo.fullName,
                  }, "确认删除"),
                  h(Button, {
                    onClick: () => { setPendingDelete(null); setConfirmText(""); },
                  }, "取消")))
            : h("div", { className: "dsh-gm-itemActions" },
                h(Button, { onClick: () => toggleVisibility(repo), disabled: busy },
                  repo.private ? "改为公开" : "改为私有"),
                canDelete(account?.scopes) === false
                  ? null
                  : h(Button, {
                      variant: "danger",
                      onClick: () => { setPendingDelete(repo); setConfirmText(""); },
                      disabled: busy,
                    }, "删除")));
      };

      return h(React.Fragment, null,
        h("div", { className: "dsh-gm-row" },
          h("input", {
            className: "dsh-gm-input",
            placeholder: "搜索仓库…",
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(Button, { onClick: () => setCreating((value) => !value), disabled: busy }, creating ? "取消" : "新建"),
          h(Button, { onClick: load, disabled: busy }, busy ? "…" : "刷新")),

        creating
          ? h("div", { className: "dsh-gm-card" },
              h(Field, { label: "仓库名" },
                h("input", {
                  className: "dsh-gm-input",
                  value: draft.name,
                  onChange: (event) => setDraft({ ...draft, name: event.target.value }),
                })),
              h(Field, { label: "描述（可选）" },
                h("input", {
                  className: "dsh-gm-input",
                  value: draft.description,
                  onChange: (event) => setDraft({ ...draft, description: event.target.value }),
                })),
              h("div", { className: "dsh-gm-row" },
                h("label", { className: "dsh-gm-note" },
                  h("input", {
                    type: "checkbox",
                    checked: draft.private,
                    onChange: (event) => setDraft({ ...draft, private: event.target.checked }),
                  }),
                  " 私有仓库")),
              h(Button, { variant: "primary", onClick: create, disabled: busy || draft.name.trim() === "" }, "创建"))
          : null,

        error !== "" ? h("div", { className: "dsh-gm-error" }, error) : null,
        status !== "" ? h("div", { className: "dsh-gm-ok" }, status) : null,

        repos === null
          ? h("div", { className: "dsh-gm-note" }, "读取中…")
          : shown.length === 0
            ? h("div", { className: "dsh-gm-note" }, repos.length === 0 ? `@${asText(account?.login)} 名下还没有仓库` : "没有匹配的仓库")
            : h("ul", { className: "dsh-gm-list" }, shown.map(renderRepo)));
    }

    /* ------------------------------------------------------------------ *
     * Upload tab
     * ------------------------------------------------------------------ */

    function UploadTab(props) {
      const account = props.account;
      const [mode, setMode] = React.useState("project");
      const [browse, setBrowse] = React.useState(null);
      const [target, setTarget] = React.useState({
        owner: asText(account?.login),
        repo: "",
        branch: "main",
        private: true,
        description: "",
        message: "",
      });
      const [single, setSingle] = React.useState({ local: "", remote: "", repo: "" });
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [status, setStatus] = React.useState("");
      const [result, setResult] = React.useState(null);

      const probe = async (dir) => {
        const answer = await post("local.probe", { dir });
        if (!answer.ok) {
          setError(asText(answer.body.message) || "无法读取目录");
          return;
        }
        setBrowse(answer.body);
        if (mode === "project") {
          setTarget((current) => current.repo === "" ? { ...current, repo: baseName(asText(answer.body.path)) } : current);
        }
      };

      React.useEffect(() => { probe(""); }, []);

      const pushProject = async () => {
        setBusy(true);
        setError("");
        setStatus("");
        setResult(null);
        const answer = await post("upload.project", {
          dir: asText(browse?.path),
          owner: target.owner.trim(),
          repo: target.repo.trim(),
          branch: target.branch.trim(),
          private: target.private,
          description: target.description,
          message: target.message,
        });
        setBusy(false);
        if (!answer.ok) {
          setError(asText(answer.body.message) || "推送失败");
          return;
        }
        setResult(answer.body);
        setStatus(`已推送 ${answer.body.uploaded} 个文件到 ${answer.body.owner}/${answer.body.repo}`);
      };

      const pushFile = async () => {
        setBusy(true);
        setError("");
        setStatus("");
        setResult(null);
        const answer = await post("upload.file", {
          owner: target.owner.trim(),
          repo: single.repo.trim(),
          local: single.local.trim(),
          path: single.remote.trim(),
          branch: target.branch.trim(),
        });
        setBusy(false);
        if (!answer.ok) {
          setError(asText(answer.body.message) || "上传失败");
          return;
        }
        setResult(answer.body);
        setStatus(`已上传到 ${answer.body.repo}/${answer.body.path}`);
      };

      const pickRow = (kind, name) => {
        if (browse === null) return;
        const base = asText(browse.path);
        const next = `${base.replace(/[\\/]+$/, "")}${base.includes("\\") ? "\\" : "/"}${name}`;
        if (kind === "dir") {
          probe(next);
          return;
        }
        setSingle((current) => ({ ...current, local: next, remote: current.remote === "" ? remotePathFor(next) : current.remote }));
      };

      return h(React.Fragment, null,
        h("div", { className: "dsh-gm-split" },
          h(Button, { variant: mode === "project" ? "primary" : undefined, onClick: () => setMode("project") }, "整个目录推送"),
          h(Button, { variant: mode === "file" ? "primary" : undefined, onClick: () => setMode("file") }, "上传单个文件")),

        h("div", { className: "dsh-gm-card" },
          h("div", { className: "dsh-gm-browseHead" },
            h("span", null, "本地路径"),
            h("span", null, asText(browse?.path))),
          h("div", { className: "dsh-gm-browse" },
            browse === null
              ? h("div", { className: "dsh-gm-note", style: { padding: "8px 9px" } }, "读取中…")
              : h(React.Fragment, null,
                  asText(browse.parent) !== ""
                    ? h("button", { type: "button", className: "dsh-gm-browseRow", "data-kind": "dir", onClick: () => probe(asText(browse.parent)) }, "↑ 上级目录")
                    : null,
                  (Array.isArray(browse.dirs) ? browse.dirs : []).map((name) =>
                    h("button", { type: "button", className: "dsh-gm-browseRow", "data-kind": "dir", key: `d:${name}`, onClick: () => pickRow("dir", name) }, `📁 ${name}`)),
                  (Array.isArray(browse.files) ? browse.files : []).map((name) =>
                    h("button", { type: "button", className: "dsh-gm-browseRow", "data-kind": "file", key: `f:${name}`, onClick: () => pickRow("file", name) }, `📄 ${name}`))))),

        mode === "project"
          ? h("div", { className: "dsh-gm-card" },
              h("div", { className: "dsh-gm-row" },
                h(Field, { label: "owner" },
                  h("input", { className: "dsh-gm-input", value: target.owner, onChange: (event) => setTarget({ ...target, owner: event.target.value }) })),
                h(Field, { label: "仓库名" },
                  h("input", { className: "dsh-gm-input", value: target.repo, onChange: (event) => setTarget({ ...target, repo: event.target.value }) }))),
              h("div", { className: "dsh-gm-row" },
                h(Field, { label: "分支" },
                  h("input", { className: "dsh-gm-input", value: target.branch, onChange: (event) => setTarget({ ...target, branch: event.target.value }) })),
                h(Field, { label: "提交说明（可选）" },
                  h("input", { className: "dsh-gm-input", value: target.message, onChange: (event) => setTarget({ ...target, message: event.target.value }) }))),
              h("div", { className: "dsh-gm-row" },
                h("label", { className: "dsh-gm-note" },
                  h("input", { type: "checkbox", checked: target.private, onChange: (event) => setTarget({ ...target, private: event.target.checked }) }),
                  " 私有（仓库不存在时按此创建）")),
              h("div", { className: "dsh-gm-note" }, "仓库不存在会自动创建；已存在则把目录内容作为一个新提交推上去。node_modules、.git、构建产物会自动跳过。"),
              h(Button, {
                variant: "primary",
                onClick: pushProject,
                disabled: busy || asText(browse?.path) === "" || target.owner.trim() === "" || target.repo.trim() === "",
              }, busy ? "推送中…" : "推送到 GitHub"))
          : h("div", { className: "dsh-gm-card" },
              h(Field, { label: "本地文件", hint: "在上面的浏览区点一个文件即可选中。" },
                h("input", { className: "dsh-gm-input", "data-mono": true, value: single.local, onChange: (event) => setSingle({ ...single, local: event.target.value }) })),
              h("div", { className: "dsh-gm-row" },
                h(Field, { label: "目标仓库" },
                  h("input", { className: "dsh-gm-input", value: single.repo, onChange: (event) => setSingle({ ...single, repo: event.target.value }) })),
                h(Field, { label: "仓库内路径" },
                  h("input", { className: "dsh-gm-input", value: single.remote, onChange: (event) => setSingle({ ...single, remote: event.target.value }) }))),
              h("div", { className: "dsh-gm-note" }, "同名文件会被更新（自动带上已有 blob 的 sha）。"),
              h(Button, {
                variant: "primary",
                onClick: pushFile,
                disabled: busy || single.local.trim() === "" || single.repo.trim() === "" || single.remote.trim() === "" || target.owner.trim() === "",
              }, busy ? "上传中…" : "上传文件")),

        error !== "" ? h("div", { className: "dsh-gm-error" }, error) : null,
        status !== "" ? h("div", { className: "dsh-gm-ok" }, status) : null,
        result !== null
          ? h("div", { className: "dsh-gm-card" },
              asText(result.url) !== ""
                ? h("a", { className: "dsh-gm-btn", href: asText(result.url), target: "_blank", rel: "noreferrer" }, "在 GitHub 打开")
                : null,
              typeof result.uploaded === "number" ? h("div", { className: "dsh-gm-note" }, `上传 ${result.uploaded} 个文件，共 ${formatBytes(result.bytes)}`) : null,
              asText(result.commit) !== "" ? h("div", { className: "dsh-gm-note" }, `提交 ${asText(result.commit).slice(0, 7)}`) : null,
              Array.isArray(result.skipped) && result.skipped.length > 0
                ? h("div", { className: "dsh-gm-note" }, `跳过 ${result.skipped.length} 项：${result.skipped.slice(0, 6).map((item) => `${item.path}`).join("、")}${result.skipped.length > 6 ? " …" : ""}`)
                : null,
              Array.isArray(result.failed) && result.failed.length > 0
                ? h("div", { className: "dsh-gm-error" }, `${result.failed.length} 个文件失败：${result.failed.slice(0, 3).map((item) => `${item.path}（${item.error}）`).join("；")}`)
                : null)
          : null);
    }

    /* ------------------------------------------------------------------ *
     * Panel + slot entry
     * ------------------------------------------------------------------ */

    function Panel(props) {
      const [tab, setTab] = React.useState("account");
      const [state, setState] = React.useState(null);
      const [anchor, setAnchor] = React.useState(null);

      const refresh = React.useCallback(async () => {
        const answer = await getState();
        setState(answer);
      }, []);

      React.useEffect(() => { refresh(); }, [refresh]);

      /* The panel is a frame-wide surface, so it is positioned from the slot
         node it was opened from rather than from any session geometry. It
         anchors to the *row* the slot renders into rather than to our own
         badge: the badge's line is stretched to the column, whose left edge the
         row shares — so the panel opens flush with the sidebar's own controls
         instead of drifting with the registration order. */
      React.useEffect(() => {
        const host = anchorNode();
        if (host === null) return;
        const row = findActionRow(host);
        const rect = (row === null ? host : row).getBoundingClientRect();
        setAnchor({ left: Math.max(8, rect.left), bottom: Math.max(8, window.innerHeight - rect.top + 8) });
      }, []);

      React.useEffect(() => {
        const onKey = (event) => { if (event.key === "Escape") props.onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, []);

      const style = anchor === null
        ? { left: 12, bottom: 96 }
        : { left: anchor.left, bottom: anchor.bottom };

      const account = state?.account ?? null;
      const ready = state !== null;

      return h("div", { className: "dsh-gm-panel", style, role: "dialog", "aria-label": "GitHub 管理" },
        h("div", { className: "dsh-gm-header" },
          h("div", { className: "dsh-gm-title" },
            h(GitHubMark, { size: 15 }),
            h("span", null, "GitHub 管理"),
            h("span", { className: "dsh-gm-version" }, `v${VERSION}`)),
          h("button", { type: "button", className: "dsh-gm-x", onClick: props.onClose, title: "关闭", "aria-label": "关闭" }, "×")),
        h("div", { className: "dsh-gm-tabs" },
          TABS.map((item) => h("button", {
            type: "button",
            key: item.id,
            className: "dsh-gm-tab",
            "data-active": tab === item.id ? "" : undefined,
            onClick: () => setTab(item.id),
          }, item.label))),
        h("div", { className: "dsh-gm-body" },
          ready === false
            ? h("div", { className: "dsh-gm-note" }, "读取状态…")
            : tab === "account"
              ? h(AccountTab, { state, refresh })
              : state.bound !== true
                ? h("div", { className: "dsh-gm-note" }, "请先在「账号」页绑定 GitHub 账号。")
                : tab === "repos"
                  ? h(RepoTab, { account })
                  : h(UploadTab, { account })));
    }

    /**
     * Fold the shell's `sidebar.footer.action` row into a column, so every
     * plugin's action owns a line and the last one stands directly above
     * Settings.
     *
     * The row belongs to the shell (`ui-sidebar`), not to this plugin, so it is
     * rewritten as an inline style — never as a stylesheet rule against a
     * generated class name — and the previous values are handed back for the
     * caller to restore when the slot node unmounts. A wide column stretches
     * each line to the sidebar width; the 56px rail centres its icons instead.
     *
     * @param row - the slot's container element, or null when it is not mounted.
     * @param wide - whether the sidebar renders wide content.
     * @returns a disposer restoring the row's own values, or null when there was
     * nothing to fold.
     */
    function foldFooterRow(row, wide) {
      if (row === null || row === undefined || row.style === undefined) return null;
      const previousDirection = row.style.flexDirection;
      const previousAlignment = row.style.alignItems;
      row.style.flexDirection = "column";
      row.style.alignItems = wide ? "stretch" : "center";
      return () => {
        row.style.flexDirection = previousDirection;
        row.style.alignItems = previousAlignment;
      };
    }

    /**
     * The element that actually lays the foot's actions out.
     *
     * List slots wrap their occupants in a `display:contents` element: it has no
     * box, so its children are flex items of the nearest boxed ancestor. That
     * makes `node.parentElement` an invisible pass-through — a wrapper whose own
     * `flex-direction` means nothing — and the row that really packs the items
     * is one level higher. Walk up until an ancestor has a box and claim it only
     * when it is a flex container; anything else means the slot is not mounted
     * the way this plugin expects, and then the shell is better left alone.
     *
     * @param node - our own node in the slot, or null before it mounts.
     * @param displayOf - reader for an element's computed `display`; injected so
     *   the walk can be asserted without a CSS engine.
     * @returns the row to fold, or null when there is nothing safe to fold.
     */
    function findActionRow(node, displayOf) {
      if (node === null || node === undefined) return null;
      const read = typeof displayOf === "function" ? displayOf : computedDisplay;
      for (let el = node.parentElement; el !== null && el !== undefined; el = el.parentElement) {
        const display = read(el);
        if (display === "contents") continue;
        return display === "flex" || display === "inline-flex" ? el : null;
      }
      return null;
    }

    /** Computed `display` of an element, or "" where no CSS engine exists. */
    function computedDisplay(el) {
      const doc = el === null || el === undefined ? null : el.ownerDocument;
      const view = doc === null || doc === undefined ? null : doc.defaultView;
      if (view === null || view === undefined) return "";
      const computed = view.getComputedStyle(el);
      return computed === null || computed === undefined ? "" : computed.display;
    }

    /** Our own node in the slot, found by the marker it always renders. */
    function anchorNode() {
      if (typeof document === "undefined" || document === null) return null;
      return document.querySelector("[data-dsh-github-manager-anchor]");
    }

    /** The sidebar badge: one slot node, holding the toggle and the panel.
     *  The sidebar foot renders either wide (a full line above Settings) or as
     *  a 56px rail; the owner hands the occupant `wide`, and the rail variant
     *  drops the text and keeps the mark, mirroring the shell's own buttons. */
    function Badge(props) {
      const [open, setOpen] = React.useState(false);
      const [state, setState] = React.useState(null);
      const layer = React.useRef(null);

      React.useEffect(() => {
        let live = true;
        getState().then((answer) => { if (live) setState(answer); });
        return () => { live = false; };
      }, [open]);

      /* The `@` source's unbound-account row raises this panel from outside
       * React; the subscription is what makes that row a real call to action. */
      React.useEffect(() => {
        const listener = () => setOpen(true);
        panelBus.listeners.add(listener);
        return () => { panelBus.listeners.delete(listener); };
      }, []);

      const bound = state?.bound === true;
      const login = asText(state?.account?.login);
      /* Missing owner props (an older shell) default to the wide presentation. */
      const wide = !(props !== undefined && props.wide === false);

      /* The badge owns the bottom line of the foot: the shared action row is
       * folded into a column here, and unfolded again when this node unmounts
       * (a disabled plugin must not leave the shell misshapen). The row is found
       * through the DOM rather than through a ref, so it works the same way the
       * panel's anchor does — and `findActionRow` skips the slot's
       * `display:contents` wrapper, which is not the element that lays items
       * out. */
      React.useEffect(() => {
        const node = layer.current === null || layer.current === undefined ? anchorNode() : layer.current;
        return foldFooterRow(findActionRow(node), wide) ?? undefined;
      }, [wide]);

      const tip = bound
        ? (login === "" ? "GitHub：已绑定" : `GitHub：@${login}`)
        : "GitHub：未绑定，点此绑定账号";

      return h("div", {
        ref: layer,
        className: wide ? "dsh-gm-layer" : "dsh-gm-layer dsh-gm-rail",
        "data-dsh-github-manager-anchor": "",
      },
        open ? h(Panel, { onClose: () => setOpen(false) }) : null,
        h("button", {
          type: "button",
          className: "dsh-gm-badge",
          "data-active": open ? "" : undefined,
          title: tip,
          "aria-label": tip,
          "aria-expanded": open ? "true" : "false",
          onClick: () => setOpen((value) => !value),
        },
          h(GitHubMark, { size: wide ? 16 : 14 }),
          /* One shrinkable text run rather than a label plus a trailing hint:
           * the row is shared with the balance card, and two runs against a
           * tight budget truncate into unreadable slivers. The login is the
           * more useful of the two, so it takes the label slot when bound and
           * the word "GitHub" stands in while the account is missing. */
          wide ? h("span", { className: "dsh-gm-badgeLabel" }, badgeLabel(bound, login)) : null,
          bound ? null : h("span", { className: "dsh-gm-dot", "data-on": undefined })));
    }

    const inject = ["slots"];

    function apply(ctx) {
      ensureStyle();
      /* `order` is ascending and sorts the whole slot across plugins, so a high
       * value takes the last line: dsh-cost-meter tops out at 2 and the shipped
       * Cordis panel button uses the default 0. This badge therefore sits below
       * every other action and immediately above Settings, which is the seat the
       * user asked for. */
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "github-manager",
        order: 500,
      }, Badge));
      attachRepoSource(ctx);
    }

    exports.apply = apply;
    exports.inject = inject;
    /* Exposed for the smoke test only: the pure helpers and the injected CSS are
     * worth asserting directly rather than through markup. */
    exports.internals = {
      VERSION,
      TABS,
      CSS,
      Badge,
      findActionRow,
      computedDisplay,
      anchorNode,
      foldFooterRow,
      badgeLabel,
      formatBytes,
      formatWhen,
      normalizeRepos,
      filterRepos,
      scopeHas,
      canDelete,
      devicePhase,
      mcpSummary,
      remotePathFor,
      baseName,
      AT_SOURCE,
      AT_MAX_ROWS,
      AT_TTL_MS,
      AT_SCOPES,
      AT_SECTION,
      AT_ROW_PANEL,
      AT_ROW_SCOPE,
      AT_SCOPE_TEXT,
      parseRepoQuery,
      repoSection,
      ownerOf,
      nameOf,
      xmlAttr,
      xmlText,
      repoSummary,
      repoClipboardText,
      repoSerialization,
      createRepoSource,
      attachRepoSource,
      panelBus,
    };
    return module.exports;
  },
});

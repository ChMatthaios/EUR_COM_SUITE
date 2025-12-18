(() => {
    const API_BASE = "http://127.0.0.1:8000/api";
    const $ = (id) => document.getElementById(id);

    // DOM (Viewer only)
    const elThemeBtn = $("themeBtn"); // may be null if you remove it from viewer.html
    const elModuleCustomer = $("module_customer_reports");
    const elModuleJsonRaw = $("module_json_raw");
    const elModuleXmlRaw = $("module_xml_raw");

    const elSideUser = $("sideUser");
    const elSideRole = $("sideRole");
    const elSideCustomer = $("sideCustomer");

    const elPageTitle = $("pageTitle");
    const elPageSub = $("pageSub");

    const elCustomerSelect = $("customerSelect");
    const elReloadBtn = $("reloadBtn");
    const elLoadBtn = $("loadBtn");
    const elLogoutBtn = $("logoutBtn");

    const elError = $("errorMessage");
    const elStatus = $("statusMessage");

    const elCustomerIdLabel = $("customerIdLabel");
    const elGeneratedAtLabel = $("generatedAtLabel");
    const elRunIdLabel = $("runIdLabel");

    const elBtnJson = $("btnJson");
    const elBtnXml = $("btnXml");

    const elDownloadJson = $("downloadJsonBtn");
    const elDownloadXml = $("downloadXmlBtn");
    const elPrintBtn = $("printBtn");

    const elNarrative = $("narrativeContainer");
    const elRaw = $("rawContainer");

    // State
    let currentMode = "JSON";
    let currentModule = "customer_reports";
    let currentReport = null;

    // -----------------------------
    // Helpers
    // -----------------------------
    function setError(msg) { if (elError) elError.textContent = msg || ""; }
    function setStatus(msg) { if (elStatus) elStatus.textContent = msg || ""; }

    function getToken() { return localStorage.getItem("ecs_token"); }
    function getStoredUser() {
        try { return JSON.parse(localStorage.getItem("ecs_user") || "null"); } catch { return null; }
    }
    function logoutToLogin() {
        localStorage.removeItem("ecs_token");
        localStorage.removeItem("ecs_user");
        window.location.href = "login.html";
    }
    function authHeaders(extra = {}) {
        const t = getToken();
        return t ? { ...extra, Authorization: `Bearer ${t}` } : extra;
    }
    async function apiFetch(path, options = {}) {
        const res = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: authHeaders(options.headers || {}),
            cache: "no-store",
        });
        if (res.status === 401) {
            logoutToLogin();
            throw new Error("Unauthorized (missing/expired token)");
        }
        return res;
    }

    // -----------------------------
    // Theme: always light
    // -----------------------------
    function forceLightTheme() {
        document.documentElement.setAttribute("data-theme", "light");
        localStorage.setItem("ecs_theme", "light");
    }

    function safeJsonParse(maybeJson) {
        if (maybeJson == null) return null;
        if (typeof maybeJson === "object") return maybeJson;
        try { return JSON.parse(String(maybeJson)); } catch { return null; }
    }

    function prettyXml(xml) {
        try {
            const PADDING = "  ";
            const reg = /(>)(<)(\/*)/g;
            let formatted = String(xml).replace(reg, "$1\r\n$2$3");
            let pad = 0;
            return formatted.split("\r\n").map((line) => {
                let indent = 0;
                if (line.match(/.+<\/\w[^>]*>$/)) indent = 0;
                else if (line.match(/^<\/\w/)) { if (pad !== 0) pad -= 1; }
                else if (line.match(/^<\w([^>]*[^/])?>.*$/)) indent = 1;
                const out = PADDING.repeat(pad) + line;
                pad += indent;
                return out;
            }).join("\n");
        } catch { return String(xml ?? ""); }
    }

    function extractReport(row) {
        return {
            runId: row?.run_id ?? null,
            customerId: row?.customer_id != null ? String(row.customer_id) : "",
            generatedAt: row?.generated_at != null ? String(row.generated_at) : "",
            json: row?.json_doc ?? "",
            xml: row?.xml_doc ?? "",
        };
    }

    function setLabels(report) {
        if (elCustomerIdLabel) elCustomerIdLabel.textContent = report?.customerId ?? "-";
        if (elGeneratedAtLabel) elGeneratedAtLabel.textContent = report?.generatedAt ?? "-";
        if (elRunIdLabel) elRunIdLabel.textContent = report?.runId ?? "-";
    }

    function clearRender() {
        if (elNarrative) elNarrative.innerHTML = "";
        if (elRaw) elRaw.textContent = "";
    }

    // -----------------------------
    // Filename rules
    // -----------------------------
    function slugify(s) {
        return String(s || "").trim().replace(/[\/\\:*?"<>|]/g, "").replace(/\s+/g, "_");
    }
    function isoStamp() {
        return new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
    }
    function getCustomerNameFromReportJson(report) {
        const parsed = safeJsonParse(report?.json);
        const customer =
            parsed?.modules?.CUSTOMER_PROFILE?.customer ||
            parsed?.customer ||
            parsed?.modules?.KYC?.customer ||
            null;
        const first = customer?.firstName || "";
        const last = customer?.lastName || "";
        const full = `${first} ${last}`.trim();
        return full || null;
    }
    function buildBaseFilename(report) {
        const user = getStoredUser();
        const ts = isoStamp();
        if (!user) return `report_${ts}`;

        if (user.role === "CUSTOMER") {
            const cname = getCustomerNameFromReportJson(report) || user.username || `customer_${report.customerId}`;
            return `${slugify(cname)}_${ts}`;
        }
        const empId = user.id ?? user.username ?? "employee";
        const custId = report?.customerId ?? "unknownCustomer";
        return `customer_${slugify(custId)}_employee_${slugify(empId)}_${ts}`;
    }

    function downloadText(filename, content, mime) {
        const blob = new Blob([content ?? ""], { type: mime || "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    // -----------------------------
    // Data cleanup for rendering
    // -----------------------------
    const NOISY_KEYS = new Set(["payload", "item", "#text"]);

    function isScalar(v) {
        return v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
    }

    function cleanKey(k) {
        return String(k || "")
            .replace(/^@/, "")
            .replace(/[_\-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function normalizeObject(obj) {
        if (!obj || typeof obj !== "object") return obj;
        if (Array.isArray(obj)) return obj.map(normalizeObject);

        if (Object.keys(obj).length === 1) {
            const onlyKey = Object.keys(obj)[0];
            if (NOISY_KEYS.has(onlyKey)) return normalizeObject(obj[onlyKey]);
        }

        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            if (NOISY_KEYS.has(k)) {
                const nv = normalizeObject(v);
                if (nv && typeof nv === "object" && !Array.isArray(nv)) {
                    for (const [mk, mv] of Object.entries(nv)) out[mk] = mv;
                } else {
                    out[k] = nv;
                }
                continue;
            }
            out[k] = normalizeObject(v);
        }
        return out;
    }

    // -----------------------------
    // Narrative renderer
    // -----------------------------
    function h(tag, className, text) {
        const n = document.createElement(tag);
        if (className) n.className = className;
        if (text != null) n.textContent = String(text);
        return n;
    }

    function renderKVGrid(obj) {
        const wrap = h("div", "kvgrid");
        for (const [k, v] of Object.entries(obj)) {
            const kk = h("div", "kkey", cleanKey(k));
            const vv = h("div", "kval", isScalar(v) ? String(v) : JSON.stringify(v));
            wrap.appendChild(kk);
            wrap.appendChild(vv);
        }
        return wrap;
    }

    function tableFromArray(arr) {
        const wrap = h("div", "table-wrap");

        const table = document.createElement("table");
        const thead = document.createElement("thead");
        const tbody = document.createElement("tbody");

        // If scalar array => 1 column table
        if (arr.length && isScalar(arr[0])) {
            const trh = document.createElement("tr");
            const th = document.createElement("th");
            th.textContent = "Value";
            trh.appendChild(th);
            thead.appendChild(trh);

            arr.forEach((x) => {
                const tr = document.createElement("tr");
                const td = document.createElement("td");
                td.textContent = x == null ? "" : String(x);
                tr.appendChild(td);
                tbody.appendChild(tr);
            });

            table.appendChild(thead);
            table.appendChild(tbody);
            wrap.appendChild(table);
            return wrap;
        }

        // Object rows
        const rows = arr.map((x) => (x && typeof x === "object") ? x : { value: x });

        // Build headers from union of keys (limited)
        const headerSet = new Set();
        for (const r of rows) for (const k of Object.keys(r)) headerSet.add(k);
        const headers = Array.from(headerSet).slice(0, 12); // keep it readable

        const trh = document.createElement("tr");
        headers.forEach((k) => {
            const th = document.createElement("th");
            th.textContent = cleanKey(k);
            trh.appendChild(th);
        });
        thead.appendChild(trh);

        function compactCell(value) {
            // Corporate rule: tables show scalars only. Complex values become a compact summary + expandable details.
            if (isScalar(value)) {
                const span = document.createElement("span");
                span.textContent = value == null ? "" : String(value);
                return span;
            }

            const details = document.createElement("details");
            details.className = "ecs-details";

            const summary = document.createElement("summary");
            summary.className = "ecs-details-summary";

            if (Array.isArray(value)) {
                summary.textContent = `Array (${value.length})`;
            } else {
                const keys = value && typeof value === "object" ? Object.keys(value).length : 0;
                summary.textContent = `Object (${keys} keys)`;
            }

            const pre = document.createElement("pre");
            pre.className = "ecs-inline-json";
            try {
                pre.textContent = JSON.stringify(value, null, 2);
            } catch {
                pre.textContent = String(value);
            }

            details.appendChild(summary);
            details.appendChild(pre);
            return details;
        }

        rows.forEach((r) => {
            const tr = document.createElement("tr");
            headers.forEach((k) => {
                const td = document.createElement("td");
                const v = r[k];
                td.appendChild(compactCell(v));
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        table.appendChild(thead);
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
    }

    /* Removed for better view of the reports. 20251218
    function renderBlockFromValue(title, value) {
        const block = h("div", "block");
        block.appendChild(h("div", "block-title", title));

        // Helper: choose "important" keys to show in bullet summaries
        const KEY_PRIORITY = [
            "id", "accountId", "cardId", "customerId", "runId",
            "status", "state", "type", "cardType",
            "amount", "balance", "currency",
            "issuedAt", "expiresOn", "date", "timestamp"
        ];

        function pickKeys(obj) {
            const keys = Object.keys(obj || {});
            // keep only scalar keys
            const scalarKeys = keys.filter(k => isScalar(obj[k]));
            // pick priority keys first
            const picked = [];
            for (const k of KEY_PRIORITY) {
                if (scalarKeys.includes(k) && !picked.includes(k)) picked.push(k);
                if (picked.length >= 4) break;
            }
            // then fill up to 4 with remaining scalar keys
            for (const k of scalarKeys) {
                if (!picked.includes(k)) picked.push(k);
                if (picked.length >= 4) break;
            }
            return picked;
        }

        function summarizeValueInline(v) {
            if (isScalar(v)) return v == null ? "" : String(v);
            if (Array.isArray(v)) return `(${v.length} items)`;
            if (v && typeof v === "object") return `(${Object.keys(v).length} fields)`;
            return String(v ?? "");
        }

        function summarizeRowAsSentence(row) {
            if (!row || typeof row !== "object") return String(row ?? "");
            const keys = pickKeys(row);

            // Build: "cardId: 29090 · status: ACTIVE · cardType: DEBIT · expiresOn: 2028-12-16"
            const parts = keys.map(k => `${cleanKey(k)}: ${summarizeValueInline(row[k])}`);

            // Add compact counts for complex fields (arrays/objects) without dumping JSON
            const complexKeys = Object.keys(row).filter(k => !isScalar(row[k]));
            const extra = complexKeys.slice(0, 3).map(k => `${cleanKey(k)}: ${summarizeValueInline(row[k])}`);
            return [...parts, ...extra].filter(Boolean).join(" · ");
        }

        // ---- Rendering rules (PDF-like) ----

        if (value == null) {
            block.appendChild(h("p", "para", "No data."));
            return block;
        }

        // If scalar => paragraph
        if (isScalar(value)) {
            block.appendChild(h("p", "para", String(value)));
            return block;
        }

        // Arrays => bullets (paragraph-friendly)
        if (Array.isArray(value)) {
            if (value.length === 0) {
                block.appendChild(h("p", "para", "No records."));
                return block;
            }

            const ul = document.createElement("ul");
            ul.className = "bullets";

            const max = 12; // keep it tight for PDF
            value.slice(0, max).forEach((row) => {
                const li = document.createElement("li");
                li.textContent = summarizeRowAsSentence(row);
                ul.appendChild(li);
            });

            block.appendChild(ul);

            if (value.length > max) {
                block.appendChild(h("p", "para muted", `Showing ${max} of ${value.length} records.`));
            }
            return block;
        }

        // Objects => treat as "section summary":
        // - show scalar fields as short paragraphs
        // - show child arrays as bullet lists (sub-blocks)
        // - show child objects as short key/value paragraph
        if (typeof value === "object") {
            const entries = Object.entries(value);

            // 1) Scalar fields as tight paragraphs
            const scalar = entries.filter(([_, v]) => isScalar(v));
            if (scalar.length) {
                const p = document.createElement("p");
                p.className = "para";
                p.textContent = scalar
                    .slice(0, 8)
                    .map(([k, v]) => `${cleanKey(k)}: ${summarizeValueInline(v)}`)
                    .join("  •  ");
                block.appendChild(p);
            }

            // 2) Arrays/objects as narrative sub-blocks (but still paragraph-friendly)
            const complex = entries.filter(([_, v]) => !isScalar(v));
            for (const [k, v] of complex) {
                if (Array.isArray(v)) {
                    block.appendChild(renderBlockFromValue(cleanKey(k), v));
                } else if (v && typeof v === "object") {
                    // show a compact paragraph, no nested deep JSON
                    const p = document.createElement("p");
                    p.className = "para";
                    const keys = Object.keys(v);
                    const scalarKeys = keys.filter(kk => isScalar(v[kk])).slice(0, 6);
                    const text = scalarKeys.length
                        ? scalarKeys.map(kk => `${cleanKey(kk)}: ${summarizeValueInline(v[kk])}`).join("  •  ")
                        : `${cleanKey(k)}: (${keys.length} fields)`;
                    block.appendChild(h("div", "block-title", cleanKey(k)));
                    block.appendChild(p);
                    p.textContent = text;
                }
            }

            return block;
        }

        // fallback
        block.appendChild(h("p", "para", String(value)));
        return block;
    }
        
    function renderReportLike(parsed) {
        const frag = document.createDocumentFragment();
        const modulesRaw = parsed?.modules && typeof parsed.modules === "object" ? parsed.modules : { REPORT: parsed };
        const modules = normalizeObject(modulesRaw);

        for (const [name, data] of Object.entries(modules)) {
            const section = h("div", "section");

            const head = h("div", "section-head");
            head.appendChild(h("h2", "section-title", cleanKey(name)));
            head.appendChild(h("div", "badge", currentMode === "XML" ? "XML" : "JSON"));
            section.appendChild(head);

            section.appendChild(renderBlockFromValue("Summary", normalizeObject(data)));
            frag.appendChild(section);
        }

        return frag;
    }
    */

    // -----------------------------
    // ✅ PDF-like narrative renderer (no placeholders)
    // -----------------------------

    function prettyLabel(k) {
        const s = String(k || "")
            .replace(/^@/, "")
            .replace(/[_\-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        // small humanizing
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function isEmptyObject(o) {
        return o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === 0;
    }

    function shouldSkipWrapperKey(parentName, key, value) {
        // Remove placeholder-y wrappers:
        // e.g. Overview -> value is object that just wraps the actual content
        const k = String(key || "").toLowerCase();
        const p = String(parentName || "").toLowerCase();

        if (k === "overview" || k === "summary") return true;

        // If key == parent name (cards -> cards), skip the outer wrapper
        if (p && k === p) return true;

        // If object has exactly 1 key and it repeats the same name, unwrap it
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const keys = Object.keys(value);
            if (keys.length === 1) {
                const only = keys[0].toLowerCase();
                if (only === k || only === p) return true;
            }
        }

        return false;
    }

    function scalarText(v) {
        if (v === null || v === undefined) return "";
        if (typeof v === "boolean") return v ? "Yes" : "No";
        return String(v);
    }

    function renderKVParagraphs(obj) {
        // PDF-like: lines, not a grid-table
        const wrap = document.createElement("div");
        wrap.className = "pdf-kv";

        for (const [k, v] of Object.entries(obj)) {
            const line = document.createElement("div");
            line.className = "pdf-line";

            const key = document.createElement("span");
            key.className = "pdf-key";
            key.textContent = `${prettyLabel(k)}: `;

            const val = document.createElement("span");
            val.className = "pdf-val";
            val.textContent = scalarText(v);

            line.appendChild(key);
            line.appendChild(val);
            wrap.appendChild(line);
        }
        return wrap;
    }

    function splitScalarAndComplex(obj) {
        const scalars = {};
        const complex = {};
        for (const [k, v] of Object.entries(obj || {})) {
            if (isScalar(v)) scalars[k] = v;
            else complex[k] = v;
        }
        return { scalars, complex };
    }

    function renderValuePDF(title, value, parentName = "") {
        // A clean block with a title only when meaningful
        const block = h("div", "block");

        if (title) {
            const t = h("div", "block-title", title);
            block.appendChild(t);
        }

        if (value == null) {
            // show nothing rather than “No data.” placeholders
            return block;
        }

        // scalar -> paragraph
        if (isScalar(value)) {
            const p = h("div", "pdf-text", scalarText(value));
            block.appendChild(p);
            return block;
        }

        // array -> numbered entries, each entry expanded cleanly
        if (Array.isArray(value)) {
            const arr = value;

            if (arr.length === 0) {
                // hide empty arrays completely (no placeholders)
                return block;
            }

            const list = document.createElement("div");
            list.className = "pdf-list";

            arr.forEach((item, idx) => {
                const entry = document.createElement("div");
                entry.className = "pdf-entry";

                const head = document.createElement("div");
                head.className = "pdf-entry-head";
                head.textContent = `${title || "Item"} ${idx + 1}`;

                entry.appendChild(head);

                if (isScalar(item)) {
                    entry.appendChild(h("div", "pdf-text", scalarText(item)));
                } else if (Array.isArray(item)) {
                    // nested array
                    entry.appendChild(renderValuePDF("", item, title));
                } else if (item && typeof item === "object") {
                    const { scalars, complex } = splitScalarAndComplex(item);
                    if (!isEmptyObject(scalars)) entry.appendChild(renderKVParagraphs(scalars));

                    // recurse complex fields
                    for (const [k, v] of Object.entries(complex)) {
                        entry.appendChild(renderValuePDF(prettyLabel(k), v, k));
                    }
                }

                list.appendChild(entry);
            });

            block.appendChild(list);
            return block;
        }

        // object -> scalar lines + nested sections
        if (value && typeof value === "object") {
            const obj = normalizeObject(value);

            // If object is a pure wrapper (payload/item) it’s already normalized earlier,
            // but we also unwrap "same-name" wrappers here.
            const { scalars, complex } = splitScalarAndComplex(obj);

            // scalar fields first
            if (!isEmptyObject(scalars)) block.appendChild(renderKVParagraphs(scalars));

            // then nested blocks (skip placeholder wrappers)
            for (const [k, v] of Object.entries(complex)) {
                if (shouldSkipWrapperKey(parentName, k, v)) {
                    // unwrap the inner content instead of rendering the wrapper title
                    const inner =
                        (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1)
                            ? v[Object.keys(v)[0]]
                            : v;
                    block.appendChild(renderValuePDF("", inner, parentName));
                    continue;
                }
                block.appendChild(renderValuePDF(prettyLabel(k), v, k));
            }

            return block;
        }

        return block;
    }

    function renderReportLike(parsed) {
        const frag = document.createDocumentFragment();

        // Modules are the structure we use for both JSON and XML (after xmlToReportLikeJson)
        const modulesRaw =
            parsed?.modules && typeof parsed.modules === "object"
                ? parsed.modules
                : { REPORT: parsed };

        const modules = normalizeObject(modulesRaw);

        for (const [moduleName, moduleData] of Object.entries(modules)) {
            const section = h("div", "section");

            // Section title only (no JSON/XML badge, no placeholders)
            const head = h("div", "section-head");
            head.appendChild(h("h2", "section-title", prettyLabel(moduleName)));
            section.appendChild(head);

            // Render module content in PDF style (no "Overview/Summary")
            const content = renderValuePDF("", moduleData, moduleName);
            section.appendChild(content);

            frag.appendChild(section);
        }

        return frag;
    }


    // -----------------------------
    // XML -> object
    // -----------------------------
    function xmlElementToObject(node) {
        if (!node || node.nodeType !== 1) return null;

        const obj = {};
        if (node.attributes && node.attributes.length) {
            for (const a of node.attributes) obj[`@${a.name}`] = a.value;
        }

        const children = Array.from(node.children || []);
        const text = (node.textContent || "").trim();

        if (children.length === 0) {
            if (Object.keys(obj).length === 0) return text;
            obj["#text"] = text;
            return obj;
        }

        for (const child of children) {
            const key = child.nodeName;
            const val = xmlElementToObject(child);
            if (obj[key] === undefined) obj[key] = val;
            else if (Array.isArray(obj[key])) obj[key].push(val);
            else obj[key] = [obj[key], val];
        }

        return obj;
    }

    function xmlToReportLikeJson(xmlString) {
        const xml = String(xmlString || "").trim();
        if (!xml) return null;

        const doc = new DOMParser().parseFromString(xml, "application/xml");
        if (doc.querySelector("parsererror")) return null;

        const root = doc.documentElement;
        const rootObj = xmlElementToObject(root);

        const maybeModules = rootObj?.Modules || rootObj?.modules || null;
        if (maybeModules && typeof maybeModules === "object") {
            return { modules: maybeModules };
        }
        return { modules: { [root.nodeName]: rootObj } };
    }

    // -----------------------------
    // Render
    // -----------------------------
    function setActiveModule(module) {
        currentModule = module;

        [elModuleCustomer, elModuleJsonRaw, elModuleXmlRaw].forEach((b) => b && b.classList.remove("active"));
        if (module === "customer_reports" && elModuleCustomer) elModuleCustomer.classList.add("active");
        if (module === "json_raw" && elModuleJsonRaw) elModuleJsonRaw.classList.add("active");
        if (module === "xml_raw" && elModuleXmlRaw) elModuleXmlRaw.classList.add("active");

        if (elPageTitle && elPageSub) {
            if (module === "customer_reports") {
                elPageTitle.textContent = "Customer Reports";
                elPageSub.textContent = "Simple tables — readable & PDF-ready";
            } else if (module === "json_raw") {
                elPageTitle.textContent = "JSON Raw (Debug)";
                elPageSub.textContent = "Pretty printed JSON text";
            } else {
                elPageTitle.textContent = "XML Raw (Debug)";
                elPageSub.textContent = "Pretty printed XML text";
            }
        }

        render();
    }

    function render() {
        clearRender();
        setError("");

        if (!currentReport) {
            setLabels(null);
            setStatus("No report loaded yet.");
            if (elNarrative) {
                elNarrative.innerHTML = "Load a report to view.";
                elNarrative.style.display = "";
            }
            if (elRaw) elRaw.style.display = "none";
            return;
        }

        setLabels(currentReport);

        if (currentModule === "json_raw") {
            if (elNarrative) elNarrative.style.display = "none";
            if (elRaw) {
                elRaw.style.display = "";
                const parsed = safeJsonParse(currentReport.json);
                elRaw.textContent = parsed ? JSON.stringify(parsed, null, 2) : String(currentReport.json ?? "");
            }
            setStatus("Raw JSON view.");
            return;
        }

        if (currentModule === "xml_raw") {
            if (elNarrative) elNarrative.style.display = "none";
            if (elRaw) {
                elRaw.style.display = "";
                elRaw.textContent = prettyXml(currentReport.xml);
            }
            setStatus("Raw XML view.");
            return;
        }

        if (elNarrative) elNarrative.style.display = "";
        if (elRaw) elRaw.style.display = "none";

        if (currentMode === "JSON") {
            const parsed = safeJsonParse(currentReport.json);
            if (!parsed) {
                setStatus("Invalid JSON — showing raw.");
                if (elNarrative) elNarrative.appendChild(h("pre", "code", String(currentReport.json ?? "")));
                return;
            }
            setStatus("JSON — simple tables (PDF-ready).");
            if (elNarrative) elNarrative.appendChild(renderReportLike(parsed));
            return;
        }

        const asJson = xmlToReportLikeJson(currentReport.xml);
        if (!asJson) {
            setStatus("Invalid XML — showing raw.");
            if (elNarrative) elNarrative.appendChild(h("pre", "code", String(currentReport.xml ?? "")));
            return;
        }

        setStatus("XML — rendered like JSON (simple tables, PDF-ready).");
        if (elNarrative) elNarrative.appendChild(renderReportLike(asJson));
    }

    // -----------------------------
    // Loading
    // -----------------------------
    async function loadCustomerListOrSelf() {
        setError("");
        setStatus("Loading...");

        const user = getStoredUser();
        if (!user || !getToken()) {
            logoutToLogin();
            return;
        }

        if (elSideUser) elSideUser.textContent = user.username ?? "-";
        if (elSideRole) elSideRole.textContent = user.role ?? "-";
        if (elSideCustomer) elSideCustomer.textContent = user.customer_id ?? "-";

        if (user.role === "CUSTOMER") {
            if (elCustomerSelect) elCustomerSelect.style.display = "none";
            if (elReloadBtn) elReloadBtn.style.display = "none";

            const res = await apiFetch("/customer/reports");
            const rows = await res.json();

            if (!Array.isArray(rows) || rows.length === 0) {
                currentReport = null;
                setStatus("");
                setError("No reports found for your customer.");
                render();
                return;
            }

            currentReport = extractReport(rows[0]);
            setStatus("Loaded your latest report.");
            render();
            return;
        }

        if (elCustomerSelect) elCustomerSelect.style.display = "";
        if (elReloadBtn) elReloadBtn.style.display = "";

        const res = await apiFetch("/customers");
        const customers = await res.json();

        if (!elCustomerSelect) return;

        elCustomerSelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Select customer...";
        elCustomerSelect.appendChild(placeholder);

        (customers || []).forEach((c) => {
            const id = c.customer_id;
            if (id == null) return;
            const opt = document.createElement("option");
            opt.value = String(id);
            opt.textContent = String(id);
            elCustomerSelect.appendChild(opt);
        });

        setStatus("Customer list loaded. Select a customer and Load Report.");
    }

    async function loadSelectedCustomerReport() {
        setError("");
        setStatus("Loading report...");

        const user = getStoredUser();
        if (!user || !getToken()) {
            logoutToLogin();
            return;
        }

        if (user.role === "CUSTOMER") {
            await loadCustomerListOrSelf();
            return;
        }

        const customerId = String(elCustomerSelect?.value || "").trim();
        if (!customerId) {
            setStatus("");
            setError("Please select a customer first.");
            return;
        }

        const res = await apiFetch(`/customers/${encodeURIComponent(customerId)}`);
        const row = await res.json();

        currentReport = extractReport(row);
        setStatus(`Loaded report for customer_id=${customerId}.`);
        render();
    }

    // -----------------------------
    // Events
    // -----------------------------
    function hookEvents() {
        // Theme toggle removed: force always-light
        if (elThemeBtn) elThemeBtn.style.display = "none";

        if (elModuleCustomer) elModuleCustomer.addEventListener("click", () => setActiveModule("customer_reports"));
        if (elModuleJsonRaw) elModuleJsonRaw.addEventListener("click", () => setActiveModule("json_raw"));
        if (elModuleXmlRaw) elModuleXmlRaw.addEventListener("click", () => setActiveModule("xml_raw"));

        if (elBtnJson) elBtnJson.addEventListener("click", () => {
            currentMode = "JSON";
            elBtnJson.classList.add("active");
            if (elBtnXml) elBtnXml.classList.remove("active");
            render();
        });

        if (elBtnXml) elBtnXml.addEventListener("click", () => {
            currentMode = "XML";
            elBtnXml.classList.add("active");
            if (elBtnJson) elBtnJson.classList.remove("active");
            render();
        });

        if (elReloadBtn) elReloadBtn.addEventListener("click", loadCustomerListOrSelf);
        if (elLoadBtn) elLoadBtn.addEventListener("click", loadSelectedCustomerReport);

        if (elLogoutBtn) elLogoutBtn.addEventListener("click", logoutToLogin);

        if (elDownloadJson) elDownloadJson.addEventListener("click", () => {
            if (!currentReport) return;
            const parsed = safeJsonParse(currentReport.json);
            const content = parsed ? JSON.stringify(parsed, null, 2) : String(currentReport.json ?? "");
            downloadText(`${buildBaseFilename(currentReport)}.json`, content, "application/json");
        });

        if (elDownloadXml) elDownloadXml.addEventListener("click", () => {
            if (!currentReport) return;
            downloadText(`${buildBaseFilename(currentReport)}.xml`, String(currentReport.xml ?? ""), "application/xml");
        });

        if (elPrintBtn) elPrintBtn.addEventListener("click", () => {
            if (!currentReport) return;

            const prevModule = currentModule;
            if (prevModule !== "customer_reports") {
                setActiveModule("customer_reports");
            }

            render();

            const base = buildBaseFilename(currentReport);
            const oldTitle = document.title;
            document.title = base;

            requestAnimationFrame(() => {
                setTimeout(() => {
                    window.print();

                    setTimeout(() => {
                        document.title = oldTitle;
                        if (prevModule !== "customer_reports") setActiveModule(prevModule);
                    }, 300);
                }, 150);
            });
        });
    }

    async function boot() {
        forceLightTheme();

        if (!getToken()) {
            window.location.href = "login.html";
            return;
        }

        hookEvents();
        setActiveModule("customer_reports");
        await loadCustomerListOrSelf();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => boot().catch(e => setError(String(e))));
    } else {
        boot().catch(e => setError(String(e)));
    }
})();
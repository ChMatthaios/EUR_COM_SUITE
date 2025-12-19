(() => {
    const API_BASE = "http://127.0.0.1:8000/api";
    const $ = (id) => document.getElementById(id);

    // -----------------------------
    // DOM (Viewer)
    // -----------------------------
    const elThemeBtn = $("themeBtn"); // optional; we force light anyway

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

    // -----------------------------
    // State
    // -----------------------------
    let currentMode = "JSON"; // JSON or XML (narrative rendering mode)
    let currentModule = "customer_reports"; // customer_reports | json_raw | xml_raw
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

    function forceLightTheme() {
        document.documentElement.setAttribute("data-theme", "light");
        localStorage.setItem("ecs_theme", "light");
        if (elThemeBtn) elThemeBtn.style.display = "none";
    }

    function isScalar(v) {
        return v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
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
    // Download naming
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
    // Normalization (JSON + XML)
    // -----------------------------
    const NOISY_KEYS = new Set(["payload", "item"]);

    function normalizeObject(obj) {
        if (!obj || typeof obj !== "object") return obj;
        if (Array.isArray(obj)) return obj.map(normalizeObject);

        // unwrap noisy wrapper if single key
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

    // Unwrap { "#text": "..." } or { "@x": "...", "#text": "..." } => "..."
    function unwrapXmlTextNodesDeep(node) {
        if (node == null) return node;
        if (Array.isArray(node)) return node.map(unwrapXmlTextNodesDeep);

        if (typeof node === "object") {
            const keys = Object.keys(node);

            if (keys.length === 1 && keys[0] === "#text") return unwrapXmlTextNodesDeep(node["#text"]);

            const hasText = keys.includes("#text");
            const onlyAttrsAndText = hasText && keys.every(k => k === "#text" || k.startsWith("@"));
            if (onlyAttrsAndText) return unwrapXmlTextNodesDeep(node["#text"]);

            const out = {};
            for (const [k, v] of Object.entries(node)) out[k] = unwrapXmlTextNodesDeep(v);
            return out;
        }

        return node;
    }

    //  IMPORTANT: Lift generic XML list containers like { item: [...] } into [...]
    // This is what fixes your "Accounts: 1 / Cards: 2" issue.
    function liftItemListsDeep(node) {
        if (node == null) return node;
        if (Array.isArray(node)) return node.map(liftItemListsDeep);

        if (typeof node === "object") {
            // if exactly { item: X } => return X (array or wrap to array)
            const keys = Object.keys(node);
            if (keys.length === 1 && keys[0].toLowerCase() === "item") {
                const lifted = liftItemListsDeep(node[keys[0]]);
                return Array.isArray(lifted) ? lifted : (lifted == null ? [] : [lifted]);
            }

            const out = {};
            for (const [k, v] of Object.entries(node)) {
                let next = liftItemListsDeep(v);

                // if value is { item: ... } lift it here too
                if (next && typeof next === "object" && !Array.isArray(next)) {
                    const k2 = Object.keys(next);
                    if (k2.length === 1 && k2[0].toLowerCase() === "item") {
                        const lifted = liftItemListsDeep(next[k2[0]]);
                        next = Array.isArray(lifted) ? lifted : (lifted == null ? [] : [lifted]);
                    }
                }

                out[k] = next;
            }
            return out;
        }

        return node;
    }

    // Force certain keys to always be arrays (helps JSON/XML parity)
    const ALWAYS_ARRAY_KEYS = new Set([
        "contacts", "addresses", "kycdocuments",
        "cards", "accounts", "flags", "loans", "fees", "transactions",
        "openauthorizations", "recentsettlements"
    ]);

    function forceArraysDeep(node) {
        if (node == null) return node;
        if (Array.isArray(node)) return node.map(forceArraysDeep);

        if (typeof node === "object") {
            const out = {};
            for (const [k, v] of Object.entries(node)) {
                const keyNorm = String(k).toLowerCase();
                let next = forceArraysDeep(v);

                if (ALWAYS_ARRAY_KEYS.has(keyNorm) && next != null && !Array.isArray(next)) {
                    next = [next];
                }
                out[k] = next;
            }
            return out;
        }

        return node;
    }

    function xmlLeafText(el) {
        // Returns text content for a leaf element (trimmed)
        return (el?.textContent ?? "").trim();
    }

    function xmlElementToReportValue(el) {
        if (!el) return null;

        const childElements = Array.from(el.children || []);

        // Leaf => scalar
        if (childElements.length === 0) {
            const t = xmlLeafText(el);
            return t;
        }

        // If all children are <item> => array list
        const allItem = childElements.every(c => c.tagName.toLowerCase() === "item");
        if (allItem) {
            return childElements.map(itemEl => xmlElementToReportValue(itemEl));
        }

        // Normal object: group children by tagName
        const obj = {};
        for (const c of childElements) {
            const key = c.tagName;
            const val = xmlElementToReportValue(c);

            if (obj[key] === undefined) obj[key] = val;
            else if (Array.isArray(obj[key])) obj[key].push(val);
            else obj[key] = [obj[key], val];
        }

        // If object is exactly { item: [...] } => lift it
        const keys = Object.keys(obj);
        if (keys.length === 1 && keys[0].toLowerCase() === "item") {
            const lifted = obj[keys[0]];
            return Array.isArray(lifted) ? lifted : (lifted == null ? [] : [lifted]);
        }

        return obj;
    }

    function xmlToReportLikeJson(xmlString) {
        const xml = String(xmlString || "").trim();
        if (!xml) return null;

        const doc = new DOMParser().parseFromString(xml, "application/xml");
        if (doc.querySelector("parsererror")) return null;

        const modulesNode = doc.querySelector("Modules");
        if (!modulesNode) {
            // fallback: whole doc as one module
            const root = doc.documentElement;
            return { modules: { [root.tagName]: xmlElementToReportValue(root) } };
        }

        const modules = {};
        const moduleEls = Array.from(modulesNode.children || []);

        for (const modEl of moduleEls) {
            const moduleName = modEl.tagName;

            // Prefer <payload>, otherwise use module element itself
            const payloadEl = modEl.querySelector(":scope > payload") || modEl;

            // Convert payload to JS value
            let payloadVal = xmlElementToReportValue(payloadEl);

            // IMPORTANT: If payloadVal is { accounts: "" } from <accounts />, make it []
            // (empty container tags should not become fake scalars)
            if (payloadVal && typeof payloadVal === "object" && !Array.isArray(payloadVal)) {
                for (const [k, v] of Object.entries(payloadVal)) {
                    if (typeof v === "string" && v.trim() === "") {
                        payloadVal[k] = [];
                    }
                }
            }

            modules[moduleName] = payloadVal;
        }

        return { modules };
    }

    // -----------------------------
    // Rendering (PDF-like tables)
    // -----------------------------
    function h(tag, className, text) {
        const n = document.createElement(tag);
        if (className) n.className = className;
        if (text != null) n.textContent = String(text);
        return n;
    }

    function titleize(k) {
        return String(k || "")
            .replace(/^@/, "")
            .replace(/[_\-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/^\w/, (c) => c.toUpperCase());
    }

    function isEmptyVal(v) {
        if (v == null) return true;
        if (Array.isArray(v)) return v.length === 0;
        if (typeof v === "object") return Object.keys(v).length === 0;
        return false;
    }

    function compactValue(v) {
        if (isScalar(v)) return v == null ? "" : String(v);
        if (Array.isArray(v)) return `${v.length}`;
        if (v && typeof v === "object") return `${Object.keys(v).length}`;
        return "";
    }

    function objectToKVTable(obj) {
        const o = obj && typeof obj === "object" ? obj : null;
        if (!o) return null;

        const tbody = document.createElement("tbody");
        for (const [k, v] of Object.entries(o)) {
            if (isEmptyVal(v)) continue;
            if (!isScalar(v)) continue;

            const tr = document.createElement("tr");
            const tdK = document.createElement("td");
            const tdV = document.createElement("td");
            tdK.className = "pdf-k";
            tdV.className = "pdf-v";
            tdK.textContent = titleize(k);
            tdV.textContent = String(v ?? "");
            tr.appendChild(tdK);
            tr.appendChild(tdV);
            tbody.appendChild(tr);
        }

        if (!tbody.children.length) return null;

        const t = document.createElement("table");
        t.className = "pdf-kv-table";
        t.appendChild(tbody);
        return t;
    }

    function arrayToTable(arr) {
        const rows = (arr || []).filter((x) => x != null);
        if (!rows.length) return null;

        const norm = rows.map((r) => (r && typeof r === "object" && !Array.isArray(r)) ? r : { value: r });

        const colSet = new Set();
        for (const r of norm) {
            for (const [k, v] of Object.entries(r)) {
                if (isScalar(v)) colSet.add(k);
                else if (v != null) colSet.add(k); // complex columns become counts
            }
        }
        const cols = Array.from(colSet).slice(0, 14);

        const table = document.createElement("table");
        table.className = "pdf-table";

        const thead = document.createElement("thead");
        const trh = document.createElement("tr");
        cols.forEach((k) => {
            const th = document.createElement("th");
            th.textContent = titleize(k);
            trh.appendChild(th);
        });
        thead.appendChild(trh);

        const tbody = document.createElement("tbody");
        norm.forEach((r) => {
            const tr = document.createElement("tr");
            cols.forEach((k) => {
                const td = document.createElement("td");
                const v = r[k];

                if (isScalar(v)) td.textContent = v == null ? "" : String(v);
                else td.textContent = compactValue(v);

                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        table.appendChild(thead);
        table.appendChild(tbody);
        return table;
    }

    function renderAny(name, value, container) {
        if (isEmptyVal(value)) return;

        if (Array.isArray(value)) {
            const t = arrayToTable(value);
            if (!t) return;

            const block = document.createElement("div");
            block.className = "pdf-block";
            if (name) block.appendChild(h("div", "pdf-block-title", titleize(name)));
            block.appendChild(t);
            container.appendChild(block);
            return;
        }

        if (value && typeof value === "object") {
            const obj = normalizeObject(value);

            const block = document.createElement("div");
            block.className = "pdf-block";
            if (name) block.appendChild(h("div", "pdf-block-title", titleize(name)));

            const kv = objectToKVTable(obj);
            if (kv) block.appendChild(kv);

            for (const [k, v] of Object.entries(obj)) {
                const lk = String(k || "").toLowerCase();
                if (lk === "summary" || lk === "overview") continue;
                if (isScalar(v) || isEmptyVal(v)) continue;

                renderAny(k, v, block);
            }

            const minChildren = name ? 1 : 0;
            if (block.children.length > minChildren) container.appendChild(block);
        }
    }

    function renderReportLike(parsed) {
        const frag = document.createDocumentFragment();

        const modulesRaw =
            parsed?.modules && typeof parsed.modules === "object"
                ? parsed.modules
                : { REPORT: parsed };

        const modules = normalizeObject(modulesRaw);

        const preferredOrder = [
            "CUSTOMER_PROFILE", "COMPLIANCE", "ACCOUNTS", "CARDS", "LOANS", "FEES", "TRANSACTIONS"
        ];

        const names = Object.keys(modules);
        names.sort((a, b) => {
            const A = String(a).toUpperCase();
            const B = String(b).toUpperCase();
            const ia = preferredOrder.indexOf(A);
            const ib = preferredOrder.indexOf(B);
            return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        });

        names.forEach((moduleName) => {
            const data = modules[moduleName];
            if (isEmptyVal(data)) return;

            const page = document.createElement("div");
            page.className = "module-page";

            const head = document.createElement("div");
            head.className = "module-head";
            head.appendChild(h("div", "module-title", titleize(moduleName)));
            page.appendChild(head);

            const body = document.createElement("div");
            body.className = "module-body";
            renderAny("", data, body);

            if (body.children.length) {
                page.appendChild(body);
                frag.appendChild(page);
            }
        });

        return frag;
    }

    // -----------------------------
    // UI switching + render pipeline
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
                elPageSub.textContent = "PDF-style tables — printable";
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
            setStatus("JSON — PDF-style tables.");
            if (elNarrative) elNarrative.appendChild(renderReportLike(parsed));
            return;
        }

        const asJson = xmlToReportLikeJson(currentReport.xml);
        if (!asJson) {
            setStatus("Invalid XML — showing raw.");
            if (elNarrative) elNarrative.appendChild(h("pre", "code", String(currentReport.xml ?? "")));
            return;
        }

        setStatus("XML — normalized to match JSON.");
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
            if (prevModule !== "customer_reports") setActiveModule("customer_reports");

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

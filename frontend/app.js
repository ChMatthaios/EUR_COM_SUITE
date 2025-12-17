(() => {
    const API_BASE = "http://127.0.0.1:8000/api";
    const $ = (id) => document.getElementById(id);

    // DOM
    const elThemeBtn = $("themeBtn");
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
    function setError(msg) { elError.textContent = msg || ""; }
    function setStatus(msg) { elStatus.textContent = msg || ""; }

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

    function setTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        localStorage.setItem("ecs_theme", theme);
    }
    function toggleTheme() {
        const cur = document.documentElement.getAttribute("data-theme") || "light";
        setTheme(cur === "light" ? "dark" : "light");
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
        elCustomerIdLabel.textContent = report?.customerId ?? "-";
        elGeneratedAtLabel.textContent = report?.generatedAt ?? "-";
        elRunIdLabel.textContent = report?.runId ?? "-";
    }

    function clearRender() {
        elNarrative.innerHTML = "";
        elRaw.textContent = "";
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
    // ✅ Data cleanup for rendering
    // -----------------------------
    const NOISY_KEYS = new Set(["payload", "item", "#text"]);

    function isScalar(v) {
        return v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
    }

    function cleanKey(k) {
        return String(k || "")
            .replace(/^@/, "")          // remove XML attribute prefix
            .replace(/[_\-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function normalizeObject(obj) {
        // removes noisy wrapper keys like payload/item, and flattens them if possible
        if (!obj || typeof obj !== "object") return obj;

        if (Array.isArray(obj)) return obj.map(normalizeObject);

        // If object is like { payload: {...} } -> unwrap payload
        if (Object.keys(obj).length === 1) {
            const onlyKey = Object.keys(obj)[0];
            if (NOISY_KEYS.has(onlyKey)) return normalizeObject(obj[onlyKey]);
        }

        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            if (NOISY_KEYS.has(k)) {
                const nv = normalizeObject(v);
                // merge if object
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
    // ✅ JSON/XML narrative renderer (tables)
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
        // arr: array of objects (or scalars)
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
                td.textContent = String(x);
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

        rows.forEach((r) => {
            const tr = document.createElement("tr");
            headers.forEach((k) => {
                const td = document.createElement("td");
                const v = r[k];
                if (isScalar(v)) td.textContent = v == null ? "" : String(v);
                else td.textContent = JSON.stringify(v);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        table.appendChild(thead);
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
    }

    function renderBlockFromValue(title, value) {
        const block = h("div", "block");
        block.appendChild(h("div", "block-title", title));

        if (value == null) {
            block.appendChild(h("div", "", "No data."));
            return block;
        }

        if (Array.isArray(value)) {
            const max = 30;
            const slice = value.slice(0, max);
            block.appendChild(tableFromArray(slice));
            if (value.length > max) block.appendChild(h("div", "badge", `Showing first ${max} rows`));
            return block;
        }

        if (typeof value === "object") {
            // split scalars vs arrays/objects
            const scalars = {};
            const complex = {};

            for (const [k, v] of Object.entries(value)) {
                if (isScalar(v)) scalars[k] = v;
                else complex[k] = v;
            }

            if (Object.keys(scalars).length) block.appendChild(renderKVGrid(scalars));

            for (const [k, v] of Object.entries(complex)) {
                if (Array.isArray(v)) {
                    block.appendChild(renderBlockFromValue(cleanKey(k), v));
                } else if (v && typeof v === "object") {
                    // nested object: show key/value grid (scalars only) + nested arrays as sub-blocks
                    const nestedScalars = {};
                    const nestedComplex = {};
                    for (const [nk, nv] of Object.entries(v)) {
                        if (isScalar(nv)) nestedScalars[nk] = nv;
                        else nestedComplex[nk] = nv;
                    }

                    const nested = h("div", "block");
                    nested.appendChild(h("div", "block-title", cleanKey(k)));
                    if (Object.keys(nestedScalars).length) nested.appendChild(renderKVGrid(nestedScalars));
                    for (const [nk, nv] of Object.entries(nestedComplex)) {
                        nested.appendChild(renderBlockFromValue(cleanKey(nk), nv));
                    }
                    block.appendChild(nested);
                } else {
                    block.appendChild(h("div", "", `${cleanKey(k)}: ${String(v)}`));
                }
            }

            return block;
        }

        // scalar
        block.appendChild(h("div", "", String(value)));
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

            // Main block (unwrap payload/item noise)
            section.appendChild(renderBlockFromValue("Overview", normalizeObject(data)));

            frag.appendChild(section);
        }

        return frag;
    }

    // -----------------------------
    // ✅ XML → object, then render like JSON
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

        [elModuleCustomer, elModuleJsonRaw, elModuleXmlRaw].forEach((b) => b.classList.remove("active"));
        if (module === "customer_reports") elModuleCustomer.classList.add("active");
        if (module === "json_raw") elModuleJsonRaw.classList.add("active");
        if (module === "xml_raw") elModuleXmlRaw.classList.add("active");

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

        render();
    }

    function render() {
        clearRender();
        setError("");

        if (!currentReport) {
            setLabels(null);
            setStatus("No report loaded yet.");
            elNarrative.innerHTML = "Load a report to view.";
            elNarrative.style.display = "";
            elRaw.style.display = "none";
            return;
        }

        setLabels(currentReport);

        if (currentModule === "json_raw") {
            elNarrative.style.display = "none";
            elRaw.style.display = "";
            const parsed = safeJsonParse(currentReport.json);
            elRaw.textContent = parsed ? JSON.stringify(parsed, null, 2) : String(currentReport.json ?? "");
            setStatus("Raw JSON view.");
            return;
        }

        if (currentModule === "xml_raw") {
            elNarrative.style.display = "none";
            elRaw.style.display = "";
            elRaw.textContent = prettyXml(currentReport.xml);
            setStatus("Raw XML view.");
            return;
        }

        // Narrative
        elNarrative.style.display = "";
        elRaw.style.display = "none";

        if (currentMode === "JSON") {
            const parsed = safeJsonParse(currentReport.json);
            if (!parsed) {
                setStatus("Invalid JSON — showing raw.");
                elNarrative.appendChild(h("pre", "code", String(currentReport.json ?? "")));
                return;
            }
            setStatus("JSON — simple tables (PDF-ready).");
            elNarrative.appendChild(renderReportLike(parsed));
            return;
        }

        const asJson = xmlToReportLikeJson(currentReport.xml);
        if (!asJson) {
            setStatus("Invalid XML — showing raw.");
            elNarrative.appendChild(h("pre", "code", String(currentReport.xml ?? "")));
            return;
        }

        setStatus("XML — rendered like JSON (simple tables, PDF-ready).");
        elNarrative.appendChild(renderReportLike(asJson));
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

        elSideUser.textContent = user.username ?? "-";
        elSideRole.textContent = user.role ?? "-";
        elSideCustomer.textContent = user.customer_id ?? "-";

        if (user.role === "CUSTOMER") {
            elCustomerSelect.style.display = "none";
            elReloadBtn.style.display = "none";

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

        elCustomerSelect.style.display = "";
        elReloadBtn.style.display = "";

        const res = await apiFetch("/customers");
        const customers = await res.json();

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

        const customerId = String(elCustomerSelect.value || "").trim();
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
        elThemeBtn.addEventListener("click", toggleTheme);

        elModuleCustomer.addEventListener("click", () => setActiveModule("customer_reports"));
        elModuleJsonRaw.addEventListener("click", () => setActiveModule("json_raw"));
        elModuleXmlRaw.addEventListener("click", () => setActiveModule("xml_raw"));

        elBtnJson.addEventListener("click", () => {
            currentMode = "JSON";
            elBtnJson.classList.add("active");
            elBtnXml.classList.remove("active");
            render();
        });

        elBtnXml.addEventListener("click", () => {
            currentMode = "XML";
            elBtnXml.classList.add("active");
            elBtnJson.classList.remove("active");
            render();
        });

        elReloadBtn.addEventListener("click", loadCustomerListOrSelf);
        elLoadBtn.addEventListener("click", loadSelectedCustomerReport);

        elLogoutBtn.addEventListener("click", logoutToLogin);

        elDownloadJson.addEventListener("click", () => {
            if (!currentReport) return;
            const parsed = safeJsonParse(currentReport.json);
            const content = parsed ? JSON.stringify(parsed, null, 2) : String(currentReport.json ?? "");
            downloadText(`${buildBaseFilename(currentReport)}.json`, content, "application/json");
        });

        elDownloadXml.addEventListener("click", () => {
            if (!currentReport) return;
            downloadText(`${buildBaseFilename(currentReport)}.xml`, String(currentReport.xml ?? ""), "application/xml");
        });

        elPrintBtn.addEventListener("click", () => {
            if (!currentReport) return;
            const base = buildBaseFilename(currentReport);
            const oldTitle = document.title;
            document.title = base;
            setTimeout(() => {
                window.print();
                setTimeout(() => (document.title = oldTitle), 300);
            }, 80);
        });
    }

    async function boot() {
        const theme = localStorage.getItem("ecs_theme") || "light";
        setTheme(theme);

        if (!getToken()) {
            window.location.href = "login.html";
            return;
        }

        hookEvents();
        setActiveModule("customer_reports");
        await loadCustomerListOrSelf();
    }

    // Init (works even if script loads late)
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => boot().catch(e => setError(String(e))));
    } else {
        boot().catch(e => setError(String(e)));
    }
})();

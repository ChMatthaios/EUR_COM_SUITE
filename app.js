(() => {
    const API_BASE = "http://127.0.0.1:8000/api";
    const $ = (id) => document.getElementById(id);

    // DOM (safe getters)
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

    // If critical elements are missing, show a clear error instead of silent failure
    function assertDom() {
        const required = [
            elPageTitle, elCustomerSelect, elLoadBtn, elLogoutBtn,
            elNarrative, elRaw, elError, elStatus,
            elBtnJson, elBtnXml, elDownloadJson, elDownloadXml, elPrintBtn,
            elModuleCustomer, elModuleJsonRaw, elModuleXmlRaw
        ];
        const ok = required.every(Boolean);
        if (!ok) {
            console.error("Viewer DOM is missing required elements. Check viewer.html ids.");
            alert("UI failed to initialize: missing required DOM elements. Check viewer.html ids.");
        }
        return ok;
    }

    // Auth
    function getToken() { return localStorage.getItem("ecs_token"); }

    function getStoredUser() {
        try { return JSON.parse(localStorage.getItem("ecs_user") || "null"); }
        catch { return null; }
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

    // UI helpers
    function setError(msg) { if (elError) elError.textContent = msg || ""; }
    function setStatus(msg) { if (elStatus) elStatus.textContent = msg || ""; }

    function setLabels(report) {
        if (elCustomerIdLabel) elCustomerIdLabel.textContent = report?.customerId ?? "-";
        if (elGeneratedAtLabel) elGeneratedAtLabel.textContent = report?.generatedAt ?? "-";
        if (elRunIdLabel) elRunIdLabel.textContent = report?.runId ?? "-";
    }

    function clearRender() {
        if (elNarrative) elNarrative.innerHTML = "";
        if (elRaw) elRaw.textContent = "";
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
        } catch {
            return String(xml ?? "");
        }
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

    // Filename rules
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

    // Narrative renderers
    function el(tag, className, text) {
        const n = document.createElement(tag);
        if (className) n.className = className;
        if (text != null) n.textContent = String(text);
        return n;
    }

    function paragraph(k, v) {
        const p = el("p", "p");
        const key = el("span", "k", `${k}: `);
        const val = document.createElement("span");
        val.textContent = String(v ?? "");
        p.appendChild(key);
        p.appendChild(val);
        return p;
    }

    function objectToOneLine(obj) {
        if (!obj || typeof obj !== "object") return String(obj ?? "");
        const parts = [];
        for (const [k, v] of Object.entries(obj)) {
            if (v === null || v === undefined) continue;
            if (typeof v === "object") continue;
            parts.push(`${k}=${v}`);
            if (parts.length >= 10) break;
        }
        return parts.length ? parts.join(", ") : "(details)";
    }

    function renderArrayAsParagraphs(parent, key, arr) {
        if (!Array.isArray(arr) || arr.length === 0) {
            parent.appendChild(paragraph(key, "No records available."));
            return;
        }
        parent.appendChild(paragraph(key, `Total records: ${arr.length}`));

        const ul = el("ul", "list");
        const max = 30;
        arr.slice(0, max).forEach((item) => {
            const li = document.createElement("li");
            li.textContent = (item && typeof item === "object") ? objectToOneLine(item) : String(item);
            ul.appendChild(li);
        });
        parent.appendChild(ul);

        if (arr.length > max) parent.appendChild(paragraph("Note", `Showing first ${max} entries (PDF-friendly).`));
    }

    function renderObjectAsParagraphs(parent, obj) {
        for (const [k, v] of Object.entries(obj || {})) {
            if (Array.isArray(v)) renderArrayAsParagraphs(parent, k, v);
            else if (v && typeof v === "object") {
                const sub = el("h3", "", k.replace(/_/g, " "));
                sub.style.margin = "14px 0 8px";
                parent.appendChild(sub);
                renderObjectAsParagraphs(parent, v);
            } else parent.appendChild(paragraph(k, v));
        }
    }

    function renderJsonNarrative(parsedJson) {
        const frag = document.createDocumentFragment();
        const modules = (parsedJson?.modules && typeof parsedJson.modules === "object")
            ? parsedJson.modules
            : { REPORT: parsedJson };

        for (const [sectionName, sectionData] of Object.entries(modules)) {
            const sec = el("div", "section");
            sec.appendChild(el("h2", "", sectionName.replace(/_/g, " ")));
            sec.appendChild(el("div", "divider"));

            if (Array.isArray(sectionData)) renderArrayAsParagraphs(sec, sectionName, sectionData);
            else if (sectionData && typeof sectionData === "object") renderObjectAsParagraphs(sec, sectionData);
            else sec.appendChild(paragraph(sectionName, sectionData));

            frag.appendChild(sec);
        }
        return frag;
    }

    function xmlToNarrative(xmlString) {
        const frag = document.createDocumentFragment();

        let doc;
        try {
            doc = new DOMParser().parseFromString(String(xmlString || ""), "application/xml");
            if (doc.querySelector("parsererror")) throw new Error("Invalid XML");
        } catch {
            const sec = el("div", "section");
            sec.appendChild(el("h2", "", "XML"));
            sec.appendChild(el("div", "divider"));
            sec.appendChild(paragraph("Note", "Invalid XML. Showing raw:"));
            sec.appendChild(el("pre", "code", String(xmlString || "")));
            frag.appendChild(sec);
            return frag;
        }

        const sec = el("div", "section");
        sec.appendChild(el("h2", "", "XML (Narrative)"));
        sec.appendChild(el("div", "divider"));

        const lines = [];
        function walk(node, path) {
            if (node.nodeType !== 1) return;
            const name = node.nodeName;
            const newPath = path ? `${path}.${name}` : name;

            if (node.attributes && node.attributes.length) {
                for (const a of node.attributes) lines.push({ k: `${newPath}@${a.name}`, v: a.value });
            }

            const children = Array.from(node.children || []);
            const text = (node.textContent || "").trim();

            if (children.length === 0 && text) {
                lines.push({ k: newPath, v: text });
                return;
            }
            children.forEach((c) => walk(c, newPath));
        }

        walk(doc.documentElement, "");

        const max = 250;
        lines.slice(0, max).forEach(({ k, v }) => sec.appendChild(paragraph(k, v)));
        if (lines.length > max) sec.appendChild(paragraph("Note", `Showing first ${max} lines (PDF-friendly).`));

        frag.appendChild(sec);
        return frag;
    }

    // Modules
    function setActiveModule(module) {
        currentModule = module;
        [elModuleCustomer, elModuleJsonRaw, elModuleXmlRaw].forEach((b) => b.classList.remove("active"));
        if (module === "customer_reports") elModuleCustomer.classList.add("active");
        if (module === "json_raw") elModuleJsonRaw.classList.add("active");
        if (module === "xml_raw") elModuleXmlRaw.classList.add("active");

        if (module === "customer_reports") {
            elPageTitle.textContent = "Customer Reports";
            elPageSub.textContent = "Readable narrative view (paragraphs) — PDF-ready";
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
            elNarrative.innerHTML = '<div class="p" style="opacity:.8;">Load a report to view.</div>';
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

        // Narrative module
        elNarrative.style.display = "";
        elRaw.style.display = "none";

        if (currentMode === "JSON") {
            const parsed = safeJsonParse(currentReport.json);
            if (!parsed) {
                setStatus("Invalid JSON — showing raw.");
                elNarrative.appendChild(el("div", "section"));
                elNarrative.appendChild(el("pre", "code", String(currentReport.json ?? "")));
                return;
            }
            setStatus("Narrative JSON view (PDF-ready).");
            elNarrative.appendChild(renderJsonNarrative(parsed));
            return;
        }

        setStatus("Narrative XML view (PDF-ready).");
        elNarrative.appendChild(xmlToNarrative(currentReport.xml));
    }

    // Loading
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

    // Events
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
        if (!assertDom()) return;

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

    // ✅ This script is loaded after DOM in viewer.html loader, but keep this safe anyway
    window.addEventListener("DOMContentLoaded", () => {
        boot().catch((e) => setError(String(e)));
    });
})();

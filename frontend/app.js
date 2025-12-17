// frontend/app.js
(() => {
    const API_BASE = "http://127.0.0.1:8000/api";

    // ----- DOM -----
    const $ = (id) => document.getElementById(id);

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
    const elAsOfDateLabel = $("asOfDateLabel");
    const elRunIdLabel = $("runIdLabel");

    const elBtnJson = $("btnJson");
    const elBtnXml = $("btnXml");

    const elDownloadJson = $("downloadJsonBtn");
    const elDownloadXml = $("downloadXmlBtn");
    const elPrintBtn = $("printBtn");

    const elJsonContainer = $("jsonContainer");
    const elXmlContainer = $("xmlContainer");

    // ----- auth helpers -----
    function getToken() {
        return localStorage.getItem("ecs_token");
    }

    function getStoredUser() {
        try {
            return JSON.parse(localStorage.getItem("ecs_user") || "null");
        } catch {
            return null;
        }
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
        });

        if (res.status === 401) {
            logoutToLogin();
            throw new Error("Unauthorized (missing/expired token)");
        }
        return res;
    }

    // ----- state -----
    let currentMode = "JSON"; // JSON or XML
    let currentModule = "customer_reports"; // customer_reports | json_raw | xml_raw
    let currentReport = null;

    // ----- UI helpers -----
    function setError(msg) {
        elError.textContent = msg || "";
    }
    function setStatus(msg) {
        elStatus.textContent = msg || "";
    }
    function setLabels({ customerId, generatedAt, runId }) {
        elCustomerIdLabel.textContent = customerId ?? "-";
        elAsOfDateLabel.textContent = generatedAt ?? "-";
        elRunIdLabel.textContent = runId ?? "-";
    }
    function clearRender() {
        elJsonContainer.innerHTML = "";
        elXmlContainer.textContent = "";
    }

    function setTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        localStorage.setItem("ecs_theme", theme);
    }
    function toggleTheme() {
        const cur = document.documentElement.getAttribute("data-theme") || "light";
        setTheme(cur === "light" ? "dark" : "light");
    }

    function h(tag, attrs = {}, children = []) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === "class") el.className = v;
            else if (k === "style") el.style.cssText = v;
            else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v);
        }
        for (const c of children) {
            if (c == null) continue;
            if (typeof c === "string") el.appendChild(document.createTextNode(c));
            else el.appendChild(c);
        }
        return el;
    }

    function isPlainObject(x) {
        return x && typeof x === "object" && !Array.isArray(x);
    }

    function safeJsonParse(maybeJson) {
        if (maybeJson == null) return null;
        if (typeof maybeJson === "object") return maybeJson;
        try {
            return JSON.parse(String(maybeJson));
        } catch {
            return null;
        }
    }

    function prettyXml(xml) {
        try {
            const PADDING = "  ";
            const reg = /(>)(<)(\/*)/g;
            let formatted = String(xml).replace(reg, "$1\r\n$2$3");
            let pad = 0;
            return formatted
                .split("\r\n")
                .map((line) => {
                    let indent = 0;
                    if (line.match(/.+<\/\w[^>]*>$/)) indent = 0;
                    else if (line.match(/^<\/\w/)) { if (pad !== 0) pad -= 1; }
                    else if (line.match(/^<\w([^>]*[^/])?>.*$/)) indent = 1;
                    else indent = 0;

                    const out = PADDING.repeat(pad) + line;
                    pad += indent;
                    return out;
                })
                .join("\n");
        } catch {
            return String(xml ?? "");
        }
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

    function slugify(s) {
        return String(s || "")
            .trim()
            .replace(/[\/\\:*?"<>|]/g, "")   // Windows illegal filename chars
            .replace(/\s+/g, "_");
    }

    function getCustomerNameFromReportJson(report) {
        // Your JSON contains: customer.firstName / customer.lastName (seen in PDF) :contentReference[oaicite:3]{index=3}
        const parsed = safeJsonParse(report?.json);
        const customer = parsed?.modules?.CUSTOMER_PROFILE?.customer || parsed?.customer || null;

        const first = customer?.firstName || "";
        const last = customer?.lastName || "";
        const full = `${first} ${last}`.trim();

        return full || null;
    }

    function buildBaseFilename(report) {
        const user = getStoredUser();
        const ts = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, ""); // 2025-12-17T12-30-00

        if (!user) return `report_${ts}`;

        if (user.role === "CUSTOMER") {
            const cname = getCustomerNameFromReportJson(report) || user.username || `customer_${report.customerId}`;
            return `${slugify(cname)}_${ts}`;
        }

        // EMPLOYEE / ADMIN
        const empId = user.id ?? user.username ?? "employee";
        const custId = report?.customerId ?? "unknownCustomer";
        return `customer_${slugify(custId)}_employee_${slugify(empId)}_${ts}`;
    }

    // ----- JSON renderer (tables within tables) -----
    function renderJsonAsNarrative(json) {
        const container = document.createElement("div");

        if (!json || typeof json !== "object") {
            container.textContent = "No structured data available.";
            return container;
        }

        const modules = json.modules || json;

        Object.entries(modules).forEach(([sectionName, sectionData]) => {
            const section = document.createElement("section");
            section.style.marginBottom = "24px";

            // Section title
            const title = document.createElement("h2");
            title.textContent = sectionName.replace(/_/g, " ");
            title.style.borderBottom = "1px solid var(--border)";
            title.style.paddingBottom = "6px";
            title.style.marginBottom = "10px";
            section.appendChild(title);

            // Render section content
            renderSectionContent(section, sectionData);

            container.appendChild(section);
        });

        return container;
    }

    // ----- mapping for your schema -----
    function extractReport(row) {
        return {
            runId: row.run_id ?? null,
            customerId: row.customer_id != null ? String(row.customer_id) : "",
            generatedAt: row.generated_at != null ? String(row.generated_at) : "",
            json: row.json_doc ?? "",
            xml: row.xml_doc ?? "",
        };
    }

    // ----- module switching -----
    function setActiveModule(module) {
        currentModule = module;

        // sidebar active state
        [elModuleCustomer, elModuleJsonRaw, elModuleXmlRaw].forEach((b) => b.classList.remove("active"));
        if (module === "customer_reports") elModuleCustomer.classList.add("active");
        if (module === "json_raw") elModuleJsonRaw.classList.add("active");
        if (module === "xml_raw") elModuleXmlRaw.classList.add("active");

        // page titles
        if (module === "customer_reports") {
            elPageTitle.textContent = "Customer Reports";
            elPageSub.textContent = "Structured view (tables, nested sections)";
        } else if (module === "json_raw") {
            elPageTitle.textContent = "JSON Raw";
            elPageSub.textContent = "Debug view (pretty printed)";
        } else {
            elPageTitle.textContent = "XML Raw";
            elPageSub.textContent = "Debug view (pretty printed)";
        }

        render();
    }

    // ----- main render (based on module + mode) -----
    function render() {
        clearRender();
        setError("");

        if (!currentReport) {
            setStatus("No report loaded yet.");
            setLabels({ customerId: "-", generatedAt: "-", runId: "-" });
            return;
        }

        setStatus("Report ready.");
        setLabels(currentReport);

        // Decide what to show based on module + mode
        const parsed = safeJsonParse(currentReport.json);

        // Default display: structured JSON for customer_reports
        if (currentModule === "customer_reports") {
            if (currentMode === "JSON") {
                elXmlContainer.style.display = "none";
                elJsonContainer.style.display = "";

                if (!parsed) {
                    elJsonContainer.appendChild(
                        h("div", { class: "details" }, [
                            h("div", { style: "color:var(--danger);font-weight:700;" }, ["Invalid JSON"]),
                            h("pre", { class: "code", style: "margin-top:10px;" }, [String(currentReport.json ?? "")]),
                        ])
                    );
                    return;
                }

                elJsonContainer.appendChild(renderJsonNode(parsed));
            } else {
                elJsonContainer.style.display = "none";
                elXmlContainer.style.display = "";
                elXmlContainer.textContent = prettyXml(currentReport.xml);
            }
            return;
        }

        // Debug modules
        if (currentModule === "json_raw") {
            elXmlContainer.style.display = "none";
            elJsonContainer.style.display = "";
            elJsonContainer.appendChild(
                h("pre", { class: "code" }, [parsed ? JSON.stringify(parsed, null, 2) : String(currentReport.json ?? "")])
            );
            return;
        }

        if (currentModule === "xml_raw") {
            elJsonContainer.style.display = "none";
            elXmlContainer.style.display = "";
            elXmlContainer.textContent = prettyXml(currentReport.xml);
            return;
        }
    }

    // ----- loading -----
    async function loadCustomerListOrSelf() {
        setError("");
        setStatus("Loading...");

        const user = getStoredUser();
        if (!user || !getToken()) {
            logoutToLogin();
            return;
        }

        // sidebar session
        elSideUser.textContent = user.username ?? "-";
        elSideRole.textContent = user.role ?? "-";
        elSideCustomer.textContent = user.customer_id ?? "-";

        // CUSTOMER: hide select + load own latest report
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

        // EMPLOYEE/ADMIN
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

        // CUSTOMER: reload self
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

    // ----- events -----
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
            const base = buildBaseFilename(currentReport);
            downloadText(`${base}.json`, content, "application/json");
        });

        elDownloadXml.addEventListener("click", () => {
            if (!currentReport) return;
            const base = buildBaseFilename(currentReport);
            downloadText(`${base}.xml`, String(currentReport.xml ?? ""), "application/xml");
        });

        const elPrintBtn = $("printBtn");
        if (elPrintBtn) {
            elPrintBtn.addEventListener("click", () => {
                if (!currentReport) return;

                // Expand all details so nested tables appear in PDF
                document.querySelectorAll("details").forEach((d) => (d.open = true));

                // Set PDF filename suggestion (browser uses the page title)
                const base = buildBaseFilename(currentReport);
                const oldTitle = document.title;
                document.title = base;

                setTimeout(() => {
                    window.print();
                    // Restore after print dialog opens
                    setTimeout(() => (document.title = oldTitle), 300);
                }, 80);
            });
        }
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

    document.addEventListener("DOMContentLoaded", () => {
        boot().catch((e) => setError(String(e)));
    });
})();

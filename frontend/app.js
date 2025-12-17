// frontend/app.js
(() => {
    const API_BASE = "http://127.0.0.1:8000/api";

    // ----- DOM helpers (safe) -----
    const $ = (id) => document.getElementById(id);
    const setText = (id, txt) => {
        const el = $(id);
        if (el) el.textContent = txt ?? "";
    };
    const setHtml = (id, html) => {
        const el = $(id);
        if (el) el.innerHTML = html ?? "";
    };
    const show = (id) => {
        const el = $(id);
        if (el) el.style.display = "";
    };
    const hide = (id) => {
        const el = $(id);
        if (el) el.style.display = "none";
    };

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
            // Missing/expired token -> back to login
            logoutToLogin();
            throw new Error("Unauthorized");
        }

        return res;
    }

    // ----- UI slots (support multiple possible IDs) -----
    // Your HTML from the repo uses specific IDs; we keep it flexible.
    const elCustomerSelect = $("customerSelect") || $("customerDropdown") || $("customer");
    const elReloadBtn = $("reloadBtn") || $("btnReload") || $("reload");
    const elLoadBtn = $("loadBtn") || $("btnLoad") || $("loadReportBtn");

    // error/status containers (your HTML shows “API error …” somewhere)
    const elError = $("errorMessage") || $("apiError") || $("error");
    const elStatus = $("statusMessage") || $("status");

    // metadata labels (based on your UI: CustomerId / AsOfDate / ExtractionDate)
    const elCustomerIdLabel = $("customerIdLabel") || $("customerId");
    const elAsOfDateLabel = $("asOfDateLabel") || $("asOfDate");
    const elExtractionDateLabel = $("extractionDateLabel") || $("extractionDate");

    // display area (code block)
    const elCode = $("codeArea") || $("output") || $("reportOutput");

    // mode buttons
    const elBtnJson = $("btnJson") || $("jsonBtn") || $("JSON");
    const elBtnXml = $("btnXml") || $("xmlBtn") || $("XML");

    // download buttons
    const elDownloadJson = $("downloadJsonBtn") || $("btnDownloadJson") || $("downloadJson");
    const elDownloadXml = $("downloadXmlBtn") || $("btnDownloadXml") || $("downloadXml");

    // ----- Viewer state -----
    let currentMode = "JSON"; // "JSON" | "XML"
    let currentReport = null; // object that contains json/xml + metadata

    function setError(msg) {
        if (elError) elError.textContent = msg || "";
        if (!msg && elError) elError.textContent = "";
    }

    function setStatus(msg) {
        if (elStatus) elStatus.textContent = msg || "";
    }

    function safeJsonParse(maybeJson) {
        if (maybeJson == null) return null;
        if (typeof maybeJson === "object") return maybeJson;
        const s = String(maybeJson);
        try {
            return JSON.parse(s);
        } catch {
            return null;
        }
    }

    // Try to detect which fields in the backend response contain JSON/XML content.
    function extractReportPayload(row) {
        // Common possibilities (adaptable):
        const jsonCandidate =
            row.json_report ??
            row.json_content ??
            row.unified_json ??
            row.report_json ??
            row.json ??
            row.JSON ??
            null;

        const xmlCandidate =
            row.xml_report ??
            row.xml_content ??
            row.unified_xml ??
            row.report_xml ??
            row.xml ??
            row.XML ??
            null;

        // Metadata possibilities
        const customerId =
            row.customer_id ?? row.customerId ?? row.CustomerId ?? row.customerID ?? null;

        const asOfDate =
            row.as_of_date ?? row.asOfDate ?? row.AsOfDate ?? row.as_of ?? null;

        const extractionDate =
            row.extraction_date ??
            row.extractionDate ??
            row.ExtractionDate ??
            row.extracted_at ??
            null;

        return {
            raw: row,
            customerId: customerId != null ? String(customerId) : "",
            asOfDate: asOfDate != null ? String(asOfDate) : "",
            extractionDate: extractionDate != null ? String(extractionDate) : "",
            json: jsonCandidate,
            xml: xmlCandidate,
        };
    }

    function render() {
        if (!currentReport) {
            setTextOnLabels("-", "-", "-");
            setCode("// select a customer and click \"Load Report\"");
            return;
        }

        setTextOnLabels(
            currentReport.customerId || "-",
            currentReport.asOfDate || "-",
            currentReport.extractionDate || "-"
        );

        if (currentMode === "JSON") {
            const obj = safeJsonParse(currentReport.json);
            if (obj) setCode(JSON.stringify(obj, null, 2));
            else setCode(String(currentReport.json ?? ""));
        } else {
            setCode(String(currentReport.xml ?? ""));
        }
    }

    function setTextOnLabels(customerId, asOfDate, extractionDate) {
        if (elCustomerIdLabel) elCustomerIdLabel.textContent = customerId ?? "-";
        if (elAsOfDateLabel) elAsOfDateLabel.textContent = asOfDate ?? "-";
        if (elExtractionDateLabel) elExtractionDateLabel.textContent = extractionDate ?? "-";
    }

    function setCode(text) {
        if (elCode) elCode.textContent = text ?? "";
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

    function hookButtons() {
        if (elBtnJson) {
            elBtnJson.addEventListener("click", () => {
                currentMode = "JSON";
                render();
            });
        }

        if (elBtnXml) {
            elBtnXml.addEventListener("click", () => {
                currentMode = "XML";
                render();
            });
        }

        if (elDownloadJson) {
            elDownloadJson.addEventListener("click", () => {
                if (!currentReport) return;
                const obj = safeJsonParse(currentReport.json);
                const content = obj ? JSON.stringify(obj, null, 2) : String(currentReport.json ?? "");
                downloadText(
                    `customer_${currentReport.customerId || "unknown"}_report.json`,
                    content,
                    "application/json"
                );
            });
        }

        if (elDownloadXml) {
            elDownloadXml.addEventListener("click", () => {
                if (!currentReport) return;
                downloadText(
                    `customer_${currentReport.customerId || "unknown"}_report.xml`,
                    String(currentReport.xml ?? ""),
                    "application/xml"
                );
            });
        }

        if (elReloadBtn) elReloadBtn.addEventListener("click", loadCustomerListOrSelf);
        if (elLoadBtn) elLoadBtn.addEventListener("click", loadSelectedCustomerReport);
    }

    // ----- Data loading -----

    async function loadCustomerListOrSelf() {
        setError("");
        setStatus("Loading...");

        const user = getStoredUser();
        const token = getToken();
        if (!user || !token) {
            logoutToLogin();
            return;
        }

        // CUSTOMER: no dropdown; load own report through customer endpoint (preferred)
        if (user.role === "CUSTOMER") {
            if (elCustomerSelect) elCustomerSelect.style.display = "none";
            if (elReloadBtn) elReloadBtn.style.display = "none";

            try {
                // Preferred secure endpoint (uses customer_id from JWT)
                const res = await apiFetch("/customer/reports");
                const rows = await res.json();

                if (!Array.isArray(rows) || rows.length === 0) {
                    setStatus("");
                    setError("No reports found for your customer.");
                    currentReport = null;
                    render();
                    return;
                }

                // choose latest (already ordered in backend; but still safe)
                const latest = extractReportPayload(rows[0]);
                currentReport = latest;
                currentMode = "JSON";
                setStatus("Loaded your latest report.");
                render();
            } catch (e) {
                setStatus("");
                setError(String(e));
            }

            return;
        }

        // EMPLOYEE/ADMIN: populate dropdown from /customers
        try {
            if (!elCustomerSelect) {
                setStatus("");
                setError("UI error: customer dropdown element not found (customerSelect).");
                return;
            }

            const res = await apiFetch("/customers");
            const customers = await res.json();

            elCustomerSelect.innerHTML = "";
            const placeholder = document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = "Select customer...";
            elCustomerSelect.appendChild(placeholder);

            (customers || []).forEach((c) => {
                const id = c.customer_id ?? c.customerId ?? c.id;
                if (id == null) return;
                const opt = document.createElement("option");
                opt.value = String(id);
                opt.textContent = String(id);
                elCustomerSelect.appendChild(opt);
            });

            setStatus("Customer list loaded.");
        } catch (e) {
            setStatus("");
            setError(String(e));
        }
    }

    async function loadSelectedCustomerReport() {
        setError("");
        setStatus("Loading report...");

        const user = getStoredUser();
        const token = getToken();
        if (!user || !token) {
            logoutToLogin();
            return;
        }

        // CUSTOMER: ignore dropdown and load self
        if (user.role === "CUSTOMER") {
            await loadCustomerListOrSelf();
            return;
        }

        // EMPLOYEE/ADMIN: must have dropdown selection
        if (!elCustomerSelect) {
            setStatus("");
            setError("UI error: customer dropdown element not found (customerSelect).");
            return;
        }

        const customerId = String(elCustomerSelect.value || "").trim();
        if (!customerId) {
            setStatus("");
            setError("Please select a customer first.");
            return;
        }

        try {
            // This assumes your existing backend endpoint returns one row for that customer
            // (or latest) including JSON/XML.
            const res = await apiFetch(`/customers/${encodeURIComponent(customerId)}`);
            const row = await res.json();

            // Some backends return { ... } or [ ... ] — support both.
            const picked = Array.isArray(row) ? row[0] : row;
            currentReport = extractReportPayload(picked);
            currentMode = "JSON";
            setStatus(`Loaded report for customer_id=${customerId}.`);
            render();
        } catch (e) {
            setStatus("");
            setError(String(e));
        }
    }

    // ----- boot -----
    async function boot() {
        hookButtons();

        // If you want to force auth to view viewer.html, keep this:
        if (!getToken()) {
            window.location.href = "login.html";
            return;
        }

        // initial load:
        await loadCustomerListOrSelf();

        // initial render placeholder:
        if (!currentReport) render();
    }

    document.addEventListener("DOMContentLoaded", () => {
        boot().catch((e) => setError(String(e)));
    });
})();

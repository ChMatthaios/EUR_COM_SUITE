const API_BASE = "http://127.0.0.1:8000/api";

const customerSelect = document.getElementById("customerSelect");
const reloadBtn = document.getElementById("reloadBtn");
const loadBtn = document.getElementById("loadBtn");

const custIdEl = document.getElementById("custId");
const asOfDateEl = document.getElementById("asOfDate");
const extractionDateEl = document.getElementById("extractionDate");

const showJsonBtn = document.getElementById("showJsonBtn");
const showXmlBtn = document.getElementById("showXmlBtn");
const downloadJsonBtn = document.getElementById("downloadJsonBtn");
const downloadXmlBtn = document.getElementById("downloadXmlBtn");

const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");

let lastReport = null;
let viewMode = "json";

function setStatus(msg, type = "info") {
    statusEl.textContent = msg || "";
    statusEl.className = `status ${type}`;
}

function prettyJson(obj) {
    return JSON.stringify(obj, null, 2);
}

function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function normalizeCustomerList(data) {
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
        return data.map(x => x.customerId ?? x.customer_id ?? x.id).filter(x => x != null);
    }
    if (Array.isArray(data)) return data;
    return [];
}

function normalizeReport(data) {
    return {
        customerId: data.customerId ?? data.customer_id ?? data.custId ?? data.CUSTID,
        asOfDate: data.asOfDate ?? data.as_of_date ?? data.ASOFDATE,
        extractionDate: data.extractionDate ?? data.generatedAt ?? data.generated_at ?? data.EXTRACTIONDATE,
        finalJson: data.finalJson ?? data.json ?? data.json_doc ?? data.FINALJSON,
        finalXml: data.finalXml ?? data.xml ?? data.xml_doc ?? data.FINALXML,
    };
}

function render() {
    if (!lastReport) return;

    custIdEl.textContent = lastReport.customerId ?? "-";
    asOfDateEl.textContent = lastReport.asOfDate ?? "-";
    extractionDateEl.textContent = lastReport.extractionDate ?? "-";

    outputEl.textContent = (viewMode === "json")
        ? prettyJson(lastReport.finalJson ?? {})
        : (lastReport.finalXml ?? "").toString();
}

async function fetchText(url) {
    const res = await fetch(url);
    const text = await res.text();
    return { res, text };
}

async function loadCustomerList() {
    setStatus(`Loading customers from ${API_BASE}/customers ...`, "info");
    customerSelect.innerHTML = "";
    lastReport = null;
    outputEl.textContent = "// select a customer and click \"Load Report\"";

    try {
        const { res, text } = await fetchText(`${API_BASE}/customers`);

        if (!res.ok) {
            setStatus(`API error: ${res.status} ${res.statusText} :: ${text}`, "err");
            return;
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            setStatus(`API returned non-JSON: ${text.slice(0, 300)}`, "err");
            return;
        }

        const ids = normalizeCustomerList(data);

        if (ids.length === 0) {
            setStatus(`API returned 0 customers. Raw: ${text.slice(0, 300)}`, "warn");
            return;
        }

        for (const id of ids) {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = id;
            customerSelect.appendChild(opt);
        }

        setStatus(`Loaded ${ids.length} customers.`, "ok");
    } catch (e) {
        setStatus(`Fetch failed. Backend running? CORS? Error: ${e.message}`, "err");
    }
}

async function loadReport() {
    const id = customerSelect.value || prompt("Enter Customer ID");
    if (!id) return;

    setStatus(`Loading report for customer ${id}...`, "info");
    lastReport = null;

    try {
        const { res, text } = await fetchText(`${API_BASE}/customers/${encodeURIComponent(id)}`);

        if (!res.ok) {
            setStatus(`API error: ${res.status} ${res.statusText} :: ${text}`, "err");
            return;
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            setStatus(`Customer API returned non-JSON: ${text.slice(0, 300)}`, "err");
            return;
        }

        lastReport = normalizeReport(data);
        setStatus("Report loaded.", "ok");
        render();
    } catch (e) {
        setStatus(`Fetch failed: ${e.message}`, "err");
    }
}

reloadBtn.addEventListener("click", loadCustomerList);
loadBtn.addEventListener("click", loadReport);

showJsonBtn.addEventListener("click", () => {
    viewMode = "json";
    showJsonBtn.classList.add("active");
    showXmlBtn.classList.remove("active");
    render();
});

showXmlBtn.addEventListener("click", () => {
    viewMode = "xml";
    showXmlBtn.classList.add("active");
    showJsonBtn.classList.remove("active");
    render();
});

downloadJsonBtn.addEventListener("click", () => {
    if (!lastReport) return setStatus("Load a report first.", "warn");
    downloadText(`customer_${lastReport.customerId}_report.json`, prettyJson(lastReport.finalJson ?? {}));
});

downloadXmlBtn.addEventListener("click", () => {
    if (!lastReport) return setStatus("Load a report first.", "warn");
    downloadText(`customer_${lastReport.customerId}_report.xml`, (lastReport.finalXml ?? "").toString());
});

loadCustomerList();

const FIELD_NAMES = {
  vendor: "Vendor Name (English)",
  picker: "Picker Rooster ID",
  pickerName: "Picker Name",
  date: "Local Order Date",
  orders: "Successful Orders",
  assignment: "Averge assignment_time (m)",
  picking: "Averge Picking Time (m)",
  mwqd: "MWQD COUNT",
  modifications: "Modification",
  items: "Picker per items (S)",
  ops: "OPS CR %",
  modificationRate: "Modification %",
};

const state = { records: [], period: "day", selectedDate: "", selectedMonth: "", pickerId: "", isAdmin: false };
const $ = (selector) => document.querySelector(selector);
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const decimalFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (value.length || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  if (quoted) throw new Error("ملف CSV غير مكتمل: يوجد نص بين علامتي اقتباس بدون إغلاق.");
  if (rows.length < 2) throw new Error("الملف لا يحتوي على صفوف بيانات.");

  const headers = rows[0].map((header) => header.trim());
  const findHeader = (name) => {
    const exact = headers.findIndex((header) => header === name);
    if (exact >= 0) return exact;
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return headers.findIndex((header) => header.toLowerCase().replace(/[^a-z0-9]/g, "") === normalized);
  };
  const indexes = Object.fromEntries(Object.entries(FIELD_NAMES).map(([key, name]) => [key, findHeader(name)]));
  for (const required of ["picker", "date", "orders"]) {
    if (indexes[required] < 0) throw new Error(`عمود مطلوب غير موجود في الملف: ${FIELD_NAMES[required]}`);
  }
  const cell = (cells, key) => indexes[key] < 0 ? "" : (cells[indexes[key]] || "").trim();
  const toNumber = (raw) => {
    const clean = String(raw || "").replace(/,/g, "").replace(/%/g, "").trim();
    const parsed = Number(clean);
    return clean && Number.isFinite(parsed) ? parsed : null;
  };
  const records = rows.slice(1).map((cells) => {
    const date = cell(cells, "date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const orderCount = toNumber(cell(cells, "orders")) ?? 0;
    const opsRaw = cell(cells, "ops");
    const modificationRaw = cell(cells, "modificationRate");
    return {
      date,
      picker: cell(cells, "picker"),
      pickerName: cell(cells, "pickerName"),
      orders: orderCount,
      assignment: toNumber(cell(cells, "assignment")),
      picking: toNumber(cell(cells, "picking")),
      mwqd: toNumber(cell(cells, "mwqd")) ?? 0,
      modifications: toNumber(cell(cells, "modifications")) ?? 0,
      items: toNumber(cell(cells, "items")),
      ops: toNumber(opsRaw) === null ? null : toNumber(opsRaw) / (opsRaw.includes("%") ? 100 : 1),
      modificationRate: toNumber(modificationRaw) === null ? null : toNumber(modificationRaw) / (modificationRaw.includes("%") ? 100 : 1),
    };
  }).filter(Boolean);
  if (!records.length) throw new Error("لم يتم العثور على بيانات بتاريخ صالح في الملف.");
  return records;
}

function weightedAverage(records, field) {
  const eligible = records.filter((record) => record.picker && record.orders > 0 && record[field] !== null);
  const totalOrders = eligible.reduce((sum, record) => sum + record.orders, 0);
  return totalOrders ? eligible.reduce((sum, record) => sum + record[field] * record.orders, 0) / totalOrders : 0;
}

function groupByPicker(records) {
  const grouped = new Map();
  records.filter((record) => record.picker).forEach((record) => {
    if (!grouped.has(record.picker)) grouped.set(record.picker, []);
    grouped.get(record.picker).push(record);
  });
  return [...grouped.entries()].map(([picker, rows]) => ({
    picker,
    pickerName: rows.find((row) => row.pickerName)?.pickerName || "",
    orders: rows.reduce((sum, row) => sum + row.orders, 0),
    assignment: weightedAverage(rows, "assignment"),
    picking: weightedAverage(rows, "picking"),
    mwqd: rows.reduce((sum, row) => sum + row.mwqd, 0),
    modifications: rows.reduce((sum, row) => sum + row.modifications, 0),
    ops: weightedAverage(rows, "ops"),
  })).sort((a, b) => b.orders - a.orders || a.picker.localeCompare(b.picker, "en"));
}

function dateLabel(date, options = { day: "numeric", month: "short", year: "numeric" }) {
  return new Intl.DateTimeFormat("ar-EG", options).format(new Date(`${date}T12:00:00`));
}

function selectedRecords() {
  return state.records.filter((record) => (state.isAdmin || record.picker === state.pickerId) && (state.period === "day"
    ? record.date === state.selectedDate
    : record.date.startsWith(state.selectedMonth)));
}

function setNotice(message = "") {
  const notice = $("#notice");
  notice.textContent = message;
  notice.hidden = !message;
}

function setStatus(message, ready = true) {
  $("#data-status").textContent = message;
  $(".status-dot").style.background = ready ? "#32bb78" : "#ff5a1f";
}

function renderChart(records) {
  const dates = [...new Set(records.map((record) => record.date))].sort();
  const dailyOrders = dates.map((date) => ({
    date,
    orders: records.filter((record) => record.date === date).reduce((sum, record) => sum + record.orders, 0),
  }));
  const maximum = Math.max(1, ...dailyOrders.map((entry) => entry.orders));
  $("#chart-title").textContent = state.period === "day" ? "الطلبات حسب اليوم" : "الطلبات خلال الشهر";
  const chart = $("#orders-chart");
  if (!dailyOrders.length) {
    chart.innerHTML = '<div class="chart-empty">لا توجد بيانات للفترة المختارة</div>';
    return;
  }
  chart.innerHTML = dailyOrders.map((entry, index) => {
    const height = Math.max(3, (entry.orders / maximum) * 100);
    const selected = state.period === "day" && entry.date === state.selectedDate ? " selected" : "";
    return `<div class="chart-column" style="animation-delay:${Math.min(index * 45, 315)}ms" title="${dateLabel(entry.date)}: ${numberFormat.format(entry.orders)} طلب">
      <div class="chart-bar-wrap"><div class="chart-bar${selected}" data-orders="${numberFormat.format(entry.orders)}" style="height:${height}%"></div></div>
      <span class="chart-day">${dateLabel(entry.date, { day: "numeric", month: "short" })}</span>
    </div>`;
  }).join("");
}

function renderPickers(records) {
  const query = $("#picker-search").value.trim().toLowerCase();
  const pickers = groupByPicker(records);
  const visible = pickers.filter((picker) => `${picker.pickerName} ${picker.picker}`.toLowerCase().includes(query));
  const body = $("#picker-rows");
  if (!visible.length) {
    body.innerHTML = '<tr><td class="empty-row" colspan="8">لا توجد بيانات مطابقة للفترة أو البحث</td></tr>';
  } else {
    body.innerHTML = visible.slice(0, 20).map((picker, index) => `<tr>
      <td>${String(index + 1).padStart(2, "0")}</td>
      <td class="picker-id">${picker.pickerName
        ? `<span class="picker-name">${escapeHtml(picker.pickerName)}</span><span class="picker-number">${escapeHtml(picker.picker)}</span>`
        : escapeHtml(picker.picker)}</td>
      <td class="order-cell">${numberFormat.format(picker.orders)}</td>
      <td>${picker.picking ? `${decimalFormat.format(picker.picking)} د` : "—"}</td>
      <td>${picker.assignment ? `${decimalFormat.format(picker.assignment)} د` : "—"}</td>
      <td>${numberFormat.format(picker.mwqd)}</td>
      <td>${numberFormat.format(picker.modifications)}</td>
      <td>${percentFormat.format(picker.ops)}</td>
    </tr>`).join("");
  }
  $("#picker-count").textContent = `${numberFormat.format(visible.length)} محضّر طلبات`;
}

function render() {
  if (!state.records.length) return;
  const records = selectedRecords();
  const detailRows = records.filter((record) => record.picker);
  const orders = records.reduce((sum, record) => sum + record.orders, 0);
  const activePickers = new Set(detailRows.map((record) => record.picker)).size;
  const modifications = records.reduce((sum, record) => sum + record.modifications, 0);
  const mwqd = records.reduce((sum, record) => sum + record.mwqd, 0);
  const days = [...new Set(records.map((record) => record.date))].sort();
  const dailyTotals = days.map((date) => ({
    date,
    orders: records.filter((record) => record.date === date).reduce((sum, record) => sum + record.orders, 0),
  }));
  const bestDay = dailyTotals.reduce((best, current) => current.orders > (best?.orders ?? -1) ? current : best, null);
  const operationRecords = detailRows.filter((record) => record.orders > 0);
  const averageItems = weightedAverage(operationRecords, "items");
  const modificationRate = orders ? modifications / orders : 0;

  $("#report-title").textContent = state.period === "day" ? "تقرير اليوم" : "تقرير الشهر";
  $("#period-caption").textContent = state.period === "day"
    ? dateLabel(state.selectedDate)
    : dateLabel(`${state.selectedMonth}-01`, { month: "long", year: "numeric" });
  $("#orders-value").textContent = numberFormat.format(orders);
  $("#orders-foot").textContent = `${numberFormat.format(orders)} طلب ناجح خلال الفترة`;
  $("#pickers-value").textContent = numberFormat.format(activePickers);
  $("#picking-value").textContent = decimalFormat.format(weightedAverage(detailRows, "picking"));
  $("#assignment-value").textContent = decimalFormat.format(weightedAverage(detailRows, "assignment"));
  $("#ops-value").textContent = percentFormat.format(weightedAverage(operationRecords, "ops"));
  $("#mwqd-value").textContent = numberFormat.format(mwqd);
  $("#modifications-value").textContent = numberFormat.format(modifications);
  $("#modifications-rate").textContent = `معدل التعديل ${percentFormat.format(modificationRate)}`;
  $("#items-value").textContent = decimalFormat.format(averageItems);
  $("#days-value").textContent = numberFormat.format(days.length);
  $("#daily-average").textContent = days.length ? numberFormat.format(orders / days.length) : "—";
  $("#best-day").textContent = bestDay ? `${dateLabel(bestDay.date, { day: "numeric", month: "short" })} · ${numberFormat.format(bestDay.orders)}` : "—";
  $("#insight-lead").textContent = orders
    ? `تم تسجيل ${numberFormat.format(orders)} طلب ناجح بمشاركة ${numberFormat.format(activePickers)} من محضّري الطلبات${state.period === "day" ? " اليوم." : " خلال الشهر."}`
    : "لا توجد بيانات للفترة المختارة. جرّب تاريخًا آخر أو حدّث ملف البيانات.";
  renderChart(records);
  renderPickers(records);
}

function updatePeriodControl() {
  const input = $("#period-input");
  const latestDate = state.records.map((record) => record.date).sort().at(-1) || "";
  if (state.period === "day") {
    input.type = "date";
    input.value = state.selectedDate || "";
    input.max = latestDate;
    $("#date-label").textContent = "التاريخ";
  } else {
    input.type = "month";
    input.value = state.selectedMonth || "";
    input.max = latestDate.slice(0, 7);
    $("#date-label").textContent = "الشهر";
  }
  render();
}

function applyData(records) {
  if (!records.length) {
    state.records = [];
    $("#period-input").disabled = true;
    setStatus("لا توجد بيانات في قاعدة البيانات", false);
    setNotice(state.isAdmin
      ? "ارفع تقرير CSV من زر «تحديث ملف البيانات» لإضافته إلى قاعدة البيانات المشتركة."
      : "لم يرفع مدير النظام تقرير الأداء بعد.");
    $(".upload-button").hidden = !state.isAdmin;
    $("#csv-file").disabled = !state.isAdmin;
    $("#picker-rows").innerHTML = '<tr><td class="empty-row" colspan="8">لا توجد بيانات أداء متاحة</td></tr>';
    $("#picker-count").textContent = "0 محضّرين";
    return;
  }
  state.records = records;
  $("#period-input").disabled = false;
  const latestDate = records.map((record) => record.date).sort().at(-1);
  state.selectedDate = latestDate;
  state.selectedMonth = latestDate.slice(0, 7);
  $("#period-input").disabled = false;
  $("#period-input").max = state.period === "day" ? latestDate : latestDate.slice(0, 7);
  setStatus(`البيانات محمّلة · ${numberFormat.format(records.length)} سجل`);
  const hasPickerData = state.isAdmin || records.some((record) => record.picker === state.pickerId);
  setNotice(hasPickerData ? "" : `لا توجد سجلات لرقم الروستر ${state.pickerId}. راجع الرقم أو تواصل مع مدير النظام.`);
  $(".upload-button").hidden = !state.isAdmin;
  $("#csv-file").disabled = !state.isAdmin;
  render();
}

async function loadInitialData() {
  try {
    const records = await window.performanceDatabase.loadRecords({
      isAdmin: state.isAdmin,
      pickerId: state.pickerId,
    });
    applyData(records);
  } catch (error) {
    setStatus("لم يتم تحميل البيانات", false);
    setNotice(`${error.message} تحقق من إعداد Firebase وقواعد Firestore.`);
    $("#picker-rows").innerHTML = '<tr><td class="empty-row" colspan="8">تعذر تحميل بيانات الأداء</td></tr>';
  }
}

$("#csv-file").addEventListener("change", async (event) => {
  if (!state.isAdmin) {
    setNotice("تحديث ملف البيانات متاح لمدير النظام فقط.");
    return;
  }
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const csv = await file.text();
    const records = parseCsv(csv);
    const result = await window.performanceDatabase.replaceRecords(records, (completed, total) => {
      setStatus(`جاري حفظ البيانات في قاعدة البيانات · ${completed} من ${total}`);
    });
    applyData(records);
    setStatus(`تم حفظ ${numberFormat.format(records.length)} سجل في قاعدة البيانات المشتركة · ${file.name}`);
    if (result.cleanupWarning) setNotice(result.cleanupWarning);
  } catch (error) {
    setNotice(`لم يتم تحديث البيانات: ${error.message}`);
    setStatus("تعذر تحديث البيانات", false);
  } finally {
    event.target.value = "";
  }
});

document.querySelectorAll(".period-button").forEach((button) => {
  button.addEventListener("click", () => {
    state.period = button.dataset.period;
    document.querySelectorAll(".period-button").forEach((item) => item.classList.toggle("active", item === button));
    updatePeriodControl();
  });
});

$("#period-input").addEventListener("change", (event) => {
  if (state.period === "day") state.selectedDate = event.target.value;
  else state.selectedMonth = event.target.value;
  render();
});

$("#picker-search").addEventListener("input", () => renderPickers(selectedRecords()));

$("#export-report").addEventListener("click", () => {
  if (!state.records.length) {
    setNotice("لا توجد بيانات لتصديرها. ارفع ملف CSV أولًا.");
    return;
  }
  window.print();
});

const cursorGlow = $(".cursor-glow");
const hasFinePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (cursorGlow && hasFinePointer && !prefersReducedMotion) {
  let x = 0;
  let y = 0;
  let targetX = 0;
  let targetY = 0;
  let animationFrame = null;
  let initialized = false;

  const moveGlow = () => {
    x += (targetX - x) * 0.22;
    y += (targetY - y) * 0.22;
    cursorGlow.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (Math.abs(targetX - x) > 0.4 || Math.abs(targetY - y) > 0.4) {
      animationFrame = requestAnimationFrame(moveGlow);
    } else {
      animationFrame = null;
    }
  };

  window.addEventListener("pointermove", (event) => {
    targetX = event.clientX;
    targetY = event.clientY;
    if (!initialized) {
      x = targetX;
      y = targetY;
      initialized = true;
      cursorGlow.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    cursorGlow.classList.add("is-visible");
    if (animationFrame === null) animationFrame = requestAnimationFrame(moveGlow);
  }, { passive: true });

  window.addEventListener("pointerleave", () => cursorGlow.classList.remove("is-visible"));
}

let hasLoadedData = false;
window.addEventListener("auth-ready", () => {
  const account = window.performanceAccount;
  state.pickerId = account?.pickerId || "";
  state.isAdmin = Boolean(account?.isAdmin);
  $(".upload-button").hidden = !state.isAdmin;
  $("#csv-file").disabled = !state.isAdmin;
  if (hasLoadedData) {
    render();
    return;
  }
  hasLoadedData = true;
  loadInitialData();
});

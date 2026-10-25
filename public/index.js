async function jsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "İstek başarısız.");
  return data;
}

function setProgress(progress, bar, percentage) {
  const value = Math.max(0, Math.min(100, Number(percentage) || 0));
  progress.setAttribute("aria-valuenow", String(value));
  bar.style.width = `${value}%`;
  bar.style.background = value > 80 ? "#f87171" : value > 50 ? "#fbbf24" : "#4ade80";
}

function renderLayout(layout, panel) {
  const wrapper = document.createElement("div");
  wrapper.className = "layout-grid public-layout-grid";
  wrapper.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(36px, 1fr))`;

  for (const cell of layout.cells) {
    const element = document.createElement("div");
    element.className = `layout-cell type-${cell.type}${cell.isOccupied ? " is-occupied" : ""}`;
    element.title = cell.type === "space"
      ? `${cell.number} numaralı yer · ${cell.isOccupied ? "Dolu" : "Boş"}`
      : cell.type === "column" ? "Kolon"
      : cell.type === "road" ? "Yol" : "Kullanılmayan alan";
    if (cell.type === "space") {
      const number = document.createElement("strong");
      number.textContent = String(cell.number);
      const status = document.createElement("span");
      status.textContent = cell.isOccupied ? "Dolu" : "Boş";
      element.append(number, status);
    } else if (cell.type === "column") element.textContent = "K";
    else if (cell.type === "road") element.textContent = "Yol";
    else element.textContent = "—";
    wrapper.append(element);
  }

  const legend = document.createElement("div");
  legend.className = "layout-legend";
  for (const [type, label] of [["space-free", "Boş park yeri"], ["space-occupied", "Dolu park yeri"], ["column", "Kolon"], ["road", "Yol"], ["blank", "Kullanılmayan"]]) {
    const item = document.createElement("span");
    item.className = `legend-item legend-${type}`;
    item.textContent = label;
    legend.append(item);
  }
  const dimensions = document.createElement("p");
  dimensions.className = "layout-caption";
  dimensions.textContent = `${layout.floorName} · ${layout.rows} satır × ${layout.cols} sütun · ${layout.occupiedSpaces}/${layout.totalSpaces} dolu · %${layout.occupancyRate} doluluk`;
  panel.replaceChildren(dimensions, wrapper, legend);
}

async function loadFloorData(parkingId) {
  return jsonResponse(await fetch(`/parkings/${encodeURIComponent(parkingId)}/floors`));
}

async function updateFloorStats(card, parkingId) {
  const data = await loadFloorData(parkingId);
  const stats = card.querySelector(".floor-stats");
  const select = card.querySelector(".floor-select");
  const selectedId = select.value;
  stats.replaceChildren();
  select.replaceChildren();

  for (const floor of data.floors) {
    const option = document.createElement("option");
    option.value = String(floor.id);
    option.textContent = floor.name;
    select.append(option);

    const item = document.createElement("div");
    item.className = "floor-stat";
    const label = document.createElement("div");
    label.className = "floor-stat-label";
    const name = document.createElement("strong");
    name.textContent = floor.name;
    const rate = document.createElement("span");
    rate.textContent = `%${Number(floor.occupancyRate).toFixed(1)}`;
    label.append(name, rate);
    const count = document.createElement("p");
    count.textContent = `${floor.occupiedSpaces}/${floor.totalSpaces} yer dolu · ${floor.freeSpaces} boş`;
    const progress = document.createElement("div");
    progress.className = "progress floor-progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    const bar = document.createElement("div");
    bar.className = "bar";
    setProgress(progress, bar, floor.occupancyRate);
    progress.append(bar);
    item.append(label, count, progress);
    stats.append(item);
  }

  if (data.floors.some(floor => String(floor.id) === selectedId)) select.value = selectedId;
  else if (data.floors.length) select.value = String(data.floors[0].id);
  return data;
}

async function showSelectedFloor(card, parkingId) {
  const panel = card.querySelector(".spaces-panel");
  const floorId = card.querySelector(".floor-select").value;
  if (!floorId) {
    panel.textContent = "Bu otoparkta henüz kat bulunmuyor.";
    return;
  }
  panel.textContent = "Kroki yükleniyor…";
  try {
    const layout = await jsonResponse(await fetch(`/parkings/${encodeURIComponent(parkingId)}/floors/${encodeURIComponent(floorId)}/layout`));
    renderLayout(layout, panel);
  } catch (error) {
    panel.textContent = error.message || "Kroki yüklenemedi.";
  }
}

async function refreshParkingData() {
  const root = document.getElementById("parkings");
  try {
    const parkings = await jsonResponse(await fetch("/parkings"));
    const currentIds = Array.from(root.querySelectorAll(".card")).map(card => Number(card.dataset.parkingId)).sort((a, b) => a - b);
    const latestIds = parkings.map(parking => Number(parking.id)).sort((a, b) => a - b);
    if (currentIds.join(",") !== latestIds.join(",")) return loadParkings();

    for (const parking of parkings) {
      const card = root.querySelector(`[data-parking-id="${parking.id}"]`);
      if (!card) continue;
      card.querySelector(".counts").textContent = `${parking.occupiedSpaces} / ${parking.totalSpaces} yer dolu`;
      card.querySelector(".free-count").textContent = `${parking.freeSpaces} boş yer`;
      const percentage = Math.max(0, Math.min(100, Number(parking.occupancyRate) || 0));
      card.querySelector(".occupancy").textContent = `%${percentage.toFixed(1)} toplam doluluk`;
      setProgress(card.querySelector(".progress"), card.querySelector(".bar"), percentage);
      const status = card.querySelector(".status");
      status.className = `status ${parking.status || "available"}`;
      status.textContent = parking.status === "incomplete" ? "Veri eksik" : parking.status === "full" ? "Otopark dolu" : "Yer mevcut";
      await updateFloorStats(card, parking.id);
      if (!card.querySelector(".spaces-panel").hidden) await showSelectedFloor(card, parking.id);
    }
  } catch {
    // Bir sonraki yenilemede yeniden denenir.
  }
}

async function loadParkings() {
  const root = document.getElementById("parkings");
  try {
    const parkings = await jsonResponse(await fetch("/parkings"));
    root.replaceChildren();
    if (!parkings.length) {
      root.textContent = "Henüz otopark yok.";
      return;
    }

    for (const parking of parkings) {
      const card = document.createElement("article");
      card.className = "card";
      card.dataset.parkingId = String(parking.id);
      const title = document.createElement("h2");
      title.textContent = parking.name;
      const count = document.createElement("p");
      count.className = "counts";
      count.textContent = `${parking.occupiedSpaces} / ${parking.totalSpaces} yer dolu`;
      const free = document.createElement("p");
      free.className = "free-count";
      free.textContent = `${parking.freeSpaces} boş yer`;
      const percentage = Math.max(0, Math.min(100, Number(parking.occupancyRate) || 0));
      const percentageText = document.createElement("p");
      percentageText.className = "occupancy";
      percentageText.textContent = `%${percentage.toFixed(1)} toplam doluluk`;
      const progress = document.createElement("div");
      progress.className = "progress";
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      const bar = document.createElement("div");
      bar.className = "bar";
      setProgress(progress, bar, percentage);
      progress.append(bar);
      const status = document.createElement("p");
      status.className = `status ${parking.status || "available"}`;
      status.textContent = parking.status === "incomplete" ? "Veri eksik" : parking.status === "full" ? "Otopark dolu" : "Yer mevcut";

      const floorTitle = document.createElement("h3");
      floorTitle.className = "floor-stats-heading";
      floorTitle.textContent = "Katlara göre doluluk";
      const floorStats = document.createElement("div");
      floorStats.className = "floor-stats";
      const mapControls = document.createElement("div");
      mapControls.className = "floor-map-controls";
      const floorLabel = document.createElement("label");
      floorLabel.textContent = "Kroki katı: ";
      const floorSelect = document.createElement("select");
      floorSelect.className = "floor-select";
      floorLabel.append(floorSelect);
      mapControls.append(floorLabel);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "layout-toggle";
      toggle.textContent = "Seçili katın krokisini göster";
      toggle.setAttribute("aria-expanded", "false");
      const panel = document.createElement("div");
      panel.className = "spaces-panel";
      panel.hidden = true;
      toggle.addEventListener("click", async () => {
        const willOpen = panel.hidden;
        panel.hidden = !willOpen;
        toggle.textContent = willOpen ? "Krokisini gizle" : "Seçili katın krokisini göster";
        toggle.setAttribute("aria-expanded", String(willOpen));
        if (willOpen) await showSelectedFloor(card, parking.id);
      });
      floorSelect.addEventListener("change", async () => {
        if (!panel.hidden) await showSelectedFloor(card, parking.id);
      });

      card.append(title, count, free, percentageText, progress, status, floorTitle, floorStats, mapControls, toggle, panel);
      root.append(card);
      await updateFloorStats(card, parking.id);
    }
  } catch (error) {
    root.textContent = error.message || "Bir hata oluştu.";
  }
}

loadParkings();
setInterval(refreshParkingData, 5000);

const adminKey = document.getElementById("adminKey");
const nameInput = document.getElementById("name");
const spacesInput = document.getElementById("spaces");
const list = document.getElementById("list");
const message = document.getElementById("message");
const keyPanel = document.getElementById("createdKeyPanel");
const keyText = document.getElementById("createdKeyText");

const CELL_TYPES = ["space", "column", "road", "blank"];
const CELL_LABELS = {
  space: "Park yeri",
  column: "Kolon",
  road: "Yol",
  blank: "Kullanılmıyor"
};

function say(text, type = "info") {
  message.textContent = text;
  message.className = `message ${type}`;
}

async function jsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `İstek başarısız (${response.status})`);
  return data;
}

function adminHeaders() {
  return { "Content-Type": "application/json", "x-admin-key": adminKey.value.trim() };
}

function parkingHeaders(key) {
  return { "Content-Type": "application/json", "x-api-key": key };
}

async function addParking() {
  const name = nameInput.value.trim();
  const totalSpaces = Number(spacesInput.value);
  if (!adminKey.value.trim()) return say("Önce yönetici anahtarını gir.", "error");
  if (!name || !Number.isSafeInteger(totalSpaces) || totalSpaces < 1)
    return say("Otopark adı ve pozitif tam sayı kapasite gir.", "error");

  try {
    const data = await jsonResponse(await fetch("/addparking", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name, totalSpaces })
    }));
    keyText.textContent = data.apiKey;
    keyPanel.hidden = false;
    nameInput.value = "";
    spacesInput.value = "";
    say("Otopark oluşturuldu. API anahtarını şimdi güvenli bir yere kaydet.", "success");
    await loadParkings();
  } catch (error) {
    say(error.message, "error");
  }
}

async function removeParking(id, name) {
  if (!adminKey.value.trim()) return say("Önce yönetici anahtarını gir.", "error");
  if (!confirm(`“${name}” otoparkı silinsin mi? Bu işlem geri alınamaz.`)) return;

  try {
    await jsonResponse(await fetch("/removeparking", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ parkingId: id })
    }));
    sessionStorage.removeItem(`otoparkbul-key-${id}`);
    say("Otopark silindi.", "success");
    await loadParkings();
  } catch (error) {
    say(error.message, "error");
  }
}

function createLayoutEditor({ parking, keyInput, parent, initialLayout }) {
  const controls = document.createElement("div");
  controls.className = "layout-controls";

  const rowsLabel = document.createElement("label");
  rowsLabel.textContent = "Satır";
  const rowsInput = document.createElement("input");
  rowsInput.type = "number";
  rowsInput.min = "1";
  rowsInput.max = "30";
  rowsInput.step = "1";
  rowsInput.value = String(initialLayout.rows);
  rowsLabel.append(rowsInput);

  const colsLabel = document.createElement("label");
  colsLabel.textContent = "Sütun";
  const colsInput = document.createElement("input");
  colsInput.type = "number";
  colsInput.min = "1";
  colsInput.max = "30";
  colsInput.step = "1";
  colsInput.value = String(initialLayout.cols);
  colsLabel.append(colsInput);

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "Krokini kaydet";
  saveButton.className = "primary";

  const hint = document.createElement("p");
  hint.className = "layout-hint";
  hint.textContent = "Hücreye tıklayarak türünü değiştir: park yeri → kolon → yol → kullanılmayan alan.";

  const legend = document.createElement("div");
  legend.className = "layout-legend";
  for (const type of CELL_TYPES) {
    const item = document.createElement("span");
    item.className = `legend-item type-${type}`;
    item.textContent = CELL_LABELS[type];
    legend.append(item);
  }

  const grid = document.createElement("div");
  grid.className = "layout-grid editor-grid";
  const note = document.createElement("p");
  note.className = "layout-hint";

  controls.append(rowsLabel, colsLabel, saveButton);
  parent.replaceChildren(controls, hint, legend, grid, note);

  let cells = new Map();
  for (const cell of initialLayout.cells) {
    cells.set(`${cell.row},${cell.col}`, { ...cell });
  }
  const hasOccupied = initialLayout.cells.some(cell => cell.type === "space" && cell.isOccupied);
  if (hasOccupied) {
    note.textContent = "Krokide değişiklik yapmadan önce otoparktaki araçların çıkışını kaydetmelisin.";
    saveButton.disabled = true;
  }

  function currentDimensions() {
    const rows = Number(rowsInput.value);
    const cols = Number(colsInput.value);
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 1 || cols < 1 || rows > 30 || cols > 30 || rows * cols > 400) {
      return null;
    }
    return { rows, cols };
  }

  function renderGrid() {
    const dimensions = currentDimensions();
    grid.replaceChildren();
    if (!dimensions) {
      note.textContent = "Satır ve sütun değerleri 1–30 arasında olmalı; toplam hücre sayısı 400'ü geçemez.";
      return;
    }
    note.textContent = hasOccupied
      ? "Krokide dolu park yeri var. Düzenlemek için önce araç çıkışlarını kaydet."
      : `${dimensions.rows * dimensions.cols} hücre · ${Array.from({ length: dimensions.rows * dimensions.cols }, (_, i) => cells.get(`${Math.floor(i / dimensions.cols) + 1},${(i % dimensions.cols) + 1}`) || { type: "space" }).filter(cell => cell.type === "space").length} park yeri`;
    grid.style.gridTemplateColumns = `repeat(${dimensions.cols}, minmax(44px, 1fr))`;

    for (let row = 1; row <= dimensions.rows; row++) {
      for (let col = 1; col <= dimensions.cols; col++) {
        const key = `${row},${col}`;
        let cell = cells.get(key);
        if (!cell) {
          cell = { row, col, type: "space", number: null, isOccupied: false };
          cells.set(key, cell);
        }
        const button = document.createElement("button");
        button.type = "button";
        button.className = `layout-cell type-${cell.type}`;
        button.title = `Satır ${row}, sütun ${col}: ${CELL_LABELS[cell.type]}`;
        if (cell.type === "space") {
          button.textContent = cell.number ? String(cell.number) : "P";
          if (cell.isOccupied) button.textContent += " · Dolu";
        } else if (cell.type === "column") {
          button.textContent = "K";
        } else if (cell.type === "road") {
          button.textContent = "Yol";
        } else {
          button.textContent = "—";
        }
        button.disabled = hasOccupied;
        button.addEventListener("click", () => {
          const current = cells.get(key) || cell;
          const nextType = CELL_TYPES[(CELL_TYPES.indexOf(current.type) + 1) % CELL_TYPES.length];
          cells.set(key, { row, col, type: nextType, number: null, isOccupied: false });
          renderGrid();
        });
        grid.append(button);
      }
    }
  }

  rowsInput.addEventListener("input", renderGrid);
  colsInput.addEventListener("input", renderGrid);
  renderGrid();

  saveButton.addEventListener("click", async () => {
    const key = keyInput.value.trim();
    if (!key) return say(`${parking.name} için otopark API anahtarını gir.`, "error");
    const dimensions = currentDimensions();
    if (!dimensions) return say("Geçerli satır ve sütun sayıları gir.", "error");
    if (hasOccupied) return say("Krokiyi değiştirmek için önce otoparkı boşalt.", "error");

    const layoutCells = [];
    for (let row = 1; row <= dimensions.rows; row++) {
      for (let col = 1; col <= dimensions.cols; col++) {
        const cell = cells.get(`${row},${col}`) || { type: "space" };
        layoutCells.push({ row, col, type: cell.type });
      }
    }

    saveButton.disabled = true;
    try {
      const result = await jsonResponse(await fetch(`/parkings/${encodeURIComponent(parking.id)}/floors/${encodeURIComponent(initialLayout.floorId)}/layout`, {
        method: "PUT",
        headers: parkingHeaders(key),
        body: JSON.stringify({ rows: dimensions.rows, cols: dimensions.cols, cells: layoutCells })
      }));
      say(`Kroki kaydedildi. Yeni kapasite: ${result.totalSpaces} park yeri.`, "success");
      await loadParkings();
    } catch (error) {
      say(error.message, "error");
      saveButton.disabled = false;
    }
  });
}

async function loadParkings() {
  try {
    const parkings = await jsonResponse(await fetch("/parkings"));
    list.replaceChildren();
    if (!parkings.length) {
      list.textContent = "Henüz otopark yok.";
      return;
    }

    for (const parking of parkings) {
      const item = document.createElement("section");
      item.className = "parking-item";
      const heading = document.createElement("h3");
      heading.textContent = parking.name;
      const info = document.createElement("p");
      info.textContent = `Toplam: ${parking.occupiedSpaces}/${parking.totalSpaces} dolu · ${parking.freeSpaces} boş · %${Number(parking.occupancyRate).toFixed(1)} dolu`;

      const keyLabel = document.createElement("label");
      keyLabel.htmlFor = `key-${parking.id}`;
      keyLabel.textContent = "Bu otoparkın API anahtarı";
      const keyInput = document.createElement("input");
      keyInput.id = `key-${parking.id}`;
      keyInput.type = "password";
      keyInput.autocomplete = "off";
      keyInput.placeholder = "pk_…";
      keyInput.className = "parking-api-key";
      keyInput.value = sessionStorage.getItem(`otoparkbul-key-${parking.id}`) || "";

      const saveKey = document.createElement("button");
      saveKey.type = "button";
      saveKey.textContent = "Anahtarı bu oturumda sakla";
      saveKey.addEventListener("click", () => {
        const value = keyInput.value.trim();
        if (value) sessionStorage.setItem(`otoparkbul-key-${parking.id}`, value);
        else sessionStorage.removeItem(`otoparkbul-key-${parking.id}`);
        say(value ? "Anahtar bu sekme oturumu için saklandı." : "Saklanan anahtar kaldırıldı.", "success");
      });

      const floorHeading = document.createElement("h4");
      floorHeading.textContent = "Katlar ve krokiler";
      const floorControls = document.createElement("div");
      floorControls.className = "layout-controls";
      const floorLabel = document.createElement("label");
      floorLabel.textContent = "Düzenlenecek kat";
      const floorSelect = document.createElement("select");
      floorSelect.id = `floor-${parking.id}`;
      floorLabel.append(floorSelect);
      let floors = [];
      try {
        const floorData = await jsonResponse(await fetch(`/parkings/${encodeURIComponent(parking.id)}/floors`));
        floors = floorData.floors;
      } catch (error) {
        say(error.message, "error");
      }
      function populateFloors() {
        floorSelect.replaceChildren();
        for (const floor of floors) {
          const option = document.createElement("option");
          option.value = String(floor.id);
          option.textContent = `${floor.name} · ${floor.occupiedSpaces}/${floor.totalSpaces} dolu (%${floor.occupancyRate})`;
          floorSelect.append(option);
        }
      }
      populateFloors();

      const addFloor = document.createElement("button");
      addFloor.type = "button";
      addFloor.textContent = "Kat ekle";
      addFloor.addEventListener("click", async () => {
        const key = keyInput.value.trim();
        if (!key) return say(`${parking.name} için otopark API anahtarını gir.`, "error");
        const name = prompt("Kat adı (örn. B1, B2, Zemin Kat):");
        if (name === null) return;
        const rows = Number(prompt("Yeni kat kaç satır olsun?", "4"));
        const cols = Number(prompt("Yeni kat kaç sütun olsun?", "5"));
        if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 1 || cols < 1 || rows > 30 || cols > 30 || rows * cols > 400) {
          return say("Satır ve sütun 1–30 arasında, toplam hücre sayısı en fazla 400 olmalı.", "error");
        }
        try {
          await jsonResponse(await fetch(`/parkings/${encodeURIComponent(parking.id)}/floors`, {
            method: "POST", headers: parkingHeaders(key), body: JSON.stringify({ name: name.trim(), rows, cols })
          }));
          say(`${name} katı oluşturuldu.`, "success");
          await loadParkings();
        } catch (error) { say(error.message, "error"); }
      });

      const deleteFloor = document.createElement("button");
      deleteFloor.type = "button";
      deleteFloor.className = "danger";
      deleteFloor.textContent = "Seçili katı sil";
      deleteFloor.addEventListener("click", async () => {
        const key = keyInput.value.trim();
        if (!key) return say(`${parking.name} için otopark API anahtarını gir.`, "error");
        const floor = floors.find(value => String(value.id) === floorSelect.value);
        if (!floor) return;
        if (!confirm(`“${floor.name}” katı silinsin mi? Katın boş olması gerekir.`)) return;
        try {
          await jsonResponse(await fetch(`/parkings/${encodeURIComponent(parking.id)}/floors/${encodeURIComponent(floor.id)}`, {
            method: "DELETE", headers: parkingHeaders(key)
          }));
          say(`${floor.name} katı silindi.`, "success");
          await loadParkings();
        } catch (error) { say(error.message, "error"); }
      });
      floorControls.append(floorLabel, addFloor, deleteFloor);

      const openEditor = document.createElement("button");
      openEditor.type = "button";
      openEditor.className = "primary";
      openEditor.textContent = "Seçili katın krokisini düzenle";
      const layoutParent = document.createElement("div");
      layoutParent.className = "layout-editor-wrap";
      layoutParent.hidden = true;
      openEditor.addEventListener("click", async () => {
        const key = keyInput.value.trim();
        if (!key) {
          say(`${parking.name} için otopark API anahtarını gir.`, "error");
          keyInput.focus();
          return;
        }
        const floorId = floorSelect.value;
        if (!floorId) return say("Önce bir kat oluştur.", "error");
        openEditor.disabled = true;
        try {
          const layout = await jsonResponse(await fetch(`/parkings/${encodeURIComponent(parking.id)}/floors/${encodeURIComponent(floorId)}/layout`));
          layoutParent.hidden = false;
          createLayoutEditor({ parking, keyInput, parent: layoutParent, initialLayout: layout });
          openEditor.textContent = "Krokisini yeniden yükle";
        } catch (error) { say(error.message, "error"); }
        finally { openEditor.disabled = false; }
      });

      const spacesHeading = document.createElement("h4");
      spacesHeading.textContent = "Park yerleri (elle durum değiştirme)";
      const spacesGrid = document.createElement("div");
      spacesGrid.className = "admin-spaces-grid";
      spacesGrid.textContent = "Yükleniyor…";
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "danger";
      deleteButton.textContent = "Otoparkı sil";
      deleteButton.addEventListener("click", () => removeParking(parking.id, parking.name));

      item.append(heading, info, keyLabel, keyInput, saveKey, floorHeading, floorControls, openEditor, layoutParent, spacesHeading, spacesGrid, deleteButton);
      list.append(item);

      try {
        const detail = await jsonResponse(await fetch(`/parkings/${encodeURIComponent(parking.id)}/spaces`));
        spacesGrid.replaceChildren();
        for (const space of detail.spaces) {
          const floor = floors.find(value => value.id === space.floorId);
          const button = document.createElement("button");
          button.type = "button";
          button.className = `admin-space ${space.isOccupied ? "occupied" : "free"}`;
          button.textContent = `${floor ? `${floor.name} · ` : ""}${space.number} · ${space.isOccupied ? "Dolu" : "Boş"}`;
          button.addEventListener("click", async () => {
            const key = keyInput.value.trim();
            if (!key) { say(`${parking.name} için otopark API anahtarını gir.`, "error"); keyInput.focus(); return; }
            let plate = "";
            if (!space.isOccupied) {
              const entered = prompt(`${floor ? floor.name + " · " : ""}${space.number} numaralı yer için plaka gir (örn. 34ABC123):`);
              if (entered === null) return;
              plate = entered.trim();
              if (!plate) return say("Bir yeri dolu işaretlemek için plaka zorunlu.", "error");
            }
            const payload = { isOccupied: !space.isOccupied };
            if (!space.isOccupied) payload.plate = plate;
            try {
              await jsonResponse(await fetch(`/spaces/${space.number}`, {
                method: "PUT", headers: parkingHeaders(key), body: JSON.stringify(payload)
              }));
              say(`${space.number} numaralı yer güncellendi.`, "success");
              await loadParkings();
            } catch (error) { say(error.message, "error"); }
          });
          spacesGrid.append(button);
        }
      } catch (error) { spacesGrid.textContent = error.message; }
    }
  } catch (error) {
    list.textContent = error.message || "Otoparklar yüklenemedi.";
  }
}

document.getElementById("addParkingButton").addEventListener("click", addParking);
document.getElementById("copyCreatedKey").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(keyText.textContent);
    say("API anahtarı kopyalandı.", "success");
  } catch {
    say("Kopyalama başarısız. Anahtarı seçip elle kopyalayabilirsin.", "error");
  }
});

loadParkings();

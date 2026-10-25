const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
require('dotenv').config();
const app = express();

app.use(express.json());
app.use(express.static('public'));

const db = new Database('database.db');


db.prepare(`
CREATE TABLE IF NOT EXISTS parkings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    total_spaces INTEGER NOT NULL,
    current_cars INTEGER DEFAULT 0,
    api_key TEXT NOT NULL
)
`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS active_cars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plate TEXT NOT NULL,
    parking_id INTEGER NOT NULL,
    entry_time TEXT NOT NULL
)
`).run();


const activeCarColumns = db.prepare(`
    PRAGMA table_info(active_cars)
`).all();

if (!activeCarColumns.some(column => column.name === "space_number")) {
    db.prepare(`
        ALTER TABLE active_cars
        ADD COLUMN space_number INTEGER
    `).run();
}
if (!activeCarColumns.some(column => column.name === "floor_id")) {
    db.prepare(`ALTER TABLE active_cars ADD COLUMN floor_id INTEGER`).run();
}

// Aynı park yerinin iki aktif araç kaydına bağlanmasını önle.
db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    idx_active_cars_parking_space
    ON active_cars (parking_id, space_number)
    WHERE space_number IS NOT NULL
`).run();


db.prepare(`
    CREATE TABLE IF NOT EXISTS parking_spaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parking_id INTEGER NOT NULL,
        space_number INTEGER NOT NULL,
        is_occupied INTEGER NOT NULL DEFAULT 0
            CHECK (is_occupied IN (0, 1)),
        plate TEXT,
        updated_at TEXT,
        UNIQUE (parking_id, space_number),
        FOREIGN KEY (parking_id) REFERENCES parkings(id)
    )
`).run();

// Eski veritabanlarına kroki koordinatlarını ekle.
const parkingSpaceColumns = db.prepare(`PRAGMA table_info(parking_spaces)`).all();
if (!parkingSpaceColumns.some(column => column.name === 'grid_row')) {
    db.prepare(`ALTER TABLE parking_spaces ADD COLUMN grid_row INTEGER`).run();
}
if (!parkingSpaceColumns.some(column => column.name === 'grid_col')) {
    db.prepare(`ALTER TABLE parking_spaces ADD COLUMN grid_col INTEGER`).run();
}
if (!parkingSpaceColumns.some(column => column.name === 'floor_id')) {
    db.prepare(`ALTER TABLE parking_spaces ADD COLUMN floor_id INTEGER`).run();
}

db.prepare(`
    CREATE TABLE IF NOT EXISTS parking_layouts (
        parking_id INTEGER PRIMARY KEY,
        rows INTEGER NOT NULL DEFAULT 1,
        cols INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (parking_id) REFERENCES parkings(id)
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS parking_grid_cells (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parking_id INTEGER NOT NULL,
        grid_row INTEGER NOT NULL,
        grid_col INTEGER NOT NULL,
        cell_type TEXT NOT NULL CHECK (cell_type IN ('column', 'road', 'blank')),
        UNIQUE (parking_id, grid_row, grid_col),
        FOREIGN KEY (parking_id) REFERENCES parkings(id)
    )
`).run();

// Katlar kendi krokilerine sahip olur. Mevcut otoparklar başlangıçta tek katla taşınır.
db.prepare(`
    CREATE TABLE IF NOT EXISTS parking_floors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parking_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        floor_order INTEGER NOT NULL DEFAULT 1,
        rows INTEGER NOT NULL DEFAULT 1,
        cols INTEGER NOT NULL DEFAULT 1,
        UNIQUE (parking_id, name),
        UNIQUE (parking_id, floor_order),
        FOREIGN KEY (parking_id) REFERENCES parkings(id) ON DELETE CASCADE
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS parking_floor_grid_cells (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        floor_id INTEGER NOT NULL,
        grid_row INTEGER NOT NULL,
        grid_col INTEGER NOT NULL,
        cell_type TEXT NOT NULL CHECK (cell_type IN ('column', 'road', 'blank')),
        UNIQUE (floor_id, grid_row, grid_col),
        FOREIGN KEY (floor_id) REFERENCES parking_floors(id) ON DELETE CASCADE
    )
`).run();

// Eski şemalardan katlara geçiş tamamlanana kadar koordinat indeksi kurulmaz.
// Aksi halde mevcut birinci katla çakışan eski koordinatlar uygulama açılışını durdurabilir.
db.prepare(`DROP INDEX IF EXISTS idx_parking_spaces_grid_position`).run();
db.prepare(`DROP INDEX IF EXISTS idx_parking_spaces_floor_grid_position`).run();

const existingParkings = db.prepare(`
    SELECT id, total_spaces
    FROM parkings
`).all();

const createSpace = db.prepare(`
    INSERT OR IGNORE INTO parking_spaces
        (parking_id, space_number)
    VALUES (?, ?)
`);

const initializeSpaces = db.transaction(() => {
    for (const parking of existingParkings) {
        for (let number = 1; number <= parking.total_spaces; number++) {
            createSpace.run(parking.id, number);
        }
    }
});

initializeSpaces();

const existing = db.prepare(`SELECT COUNT(*) as count FROM parkings`).get();

if (existing.count === 0) {

    const apiKey = generateApiKey();

    db.prepare(`
        INSERT INTO parkings (
            name,
            total_spaces,
            current_cars,
            api_key
        )
        VALUES (?, ?, ?, ?)
    `).run(
        "OtoparkBul Test Otoparkı",
        10,
        0,
        apiKey
    );

    console.log("TEST API KEY:", apiKey);
}

const allParkings = db.prepare(`
    SELECT id, total_spaces FROM parkings
`).all();

const ensureSpace = db.prepare(`
    INSERT OR IGNORE INTO parking_spaces
        (parking_id, space_number)
    VALUES (?, ?)
`);

const ensureAllSpaces = db.transaction(() => {
    for (const parking of allParkings) {
        for (let n = 1; n <= parking.total_spaces; n++) {
            ensureSpace.run(parking.id, n);
        }
    }
});

ensureAllSpaces();

// Her otopark için varsayılan bir ızgara oluştur; eski park yerlerine koordinat ata.
const initializeLayouts = db.transaction(() => {
    const parkings = db.prepare(`SELECT id, total_spaces FROM parkings`).all();
    const insertLayout = db.prepare(`
        INSERT OR IGNORE INTO parking_layouts (parking_id, rows, cols)
        VALUES (?, ?, ?)
    `);
    const updateCoordinates = db.prepare(`
        UPDATE parking_spaces
        SET grid_row = CAST((space_number - 1) / ? AS INTEGER) + 1,
            grid_col = ((space_number - 1) % ?) + 1
        WHERE parking_id = ? AND floor_id IS NULL
`);

    for (const parking of parkings) {
        const cols = Math.max(1, Math.min(5, parking.total_spaces));
        const rows = Math.max(1, Math.ceil(parking.total_spaces / cols));
        insertLayout.run(parking.id, rows, cols);
        updateCoordinates.run(cols, cols, parking.id);
    }
});
initializeLayouts();

const initializeFloors = db.transaction(() => {
    const parkings = db.prepare(`
        SELECT p.id, COALESCE(l.rows, 1) AS rows, COALESCE(l.cols, 1) AS cols
        FROM parkings p
        LEFT JOIN parking_layouts l ON l.parking_id = p.id
    `).all();
    const insertFloor = db.prepare(`
        INSERT OR IGNORE INTO parking_floors (parking_id, name, floor_order, rows, cols)
        VALUES (?, 'Zemin Kat', 1, ?, ?)
    `);
    for (const parking of parkings) {
        insertFloor.run(parking.id, parking.rows, parking.cols);
        const floor = db.prepare(`
            SELECT id FROM parking_floors WHERE parking_id = ? AND floor_order = 1
        `).get(parking.id);
        const unassignedSpaces = db.prepare(`
            SELECT id, grid_row, grid_col FROM parking_spaces
            WHERE parking_id = ? AND floor_id IS NULL ORDER BY space_number
        `).all(parking.id);
        const usedCoordinates = new Set(db.prepare(`
            SELECT grid_row, grid_col FROM parking_spaces
            WHERE floor_id = ? AND grid_row IS NOT NULL AND grid_col IS NOT NULL
        `).all(floor.id).map(space => `${space.grid_row},${space.grid_col}`));
        const placeSpace = db.prepare(`
            UPDATE parking_spaces SET floor_id = ?, grid_row = ?, grid_col = ? WHERE id = ?
        `);
        let nextRow = Math.max(1, parking.rows);
        let nextCol = 1;
        for (const space of unassignedSpaces) {
            let row = space.grid_row;
            let col = space.grid_col;
            if (!Number.isSafeInteger(row) || row < 1 || !Number.isSafeInteger(col) || col < 1 || usedCoordinates.has(`${row},${col}`)) {
                while (usedCoordinates.has(`${nextRow},${nextCol}`)) {
                    nextCol++;
                    if (nextCol > Math.max(1, parking.cols)) { nextCol = 1; nextRow++; }
                }
                row = nextRow;
                col = nextCol;
                nextCol++;
                if (nextCol > Math.max(1, parking.cols)) { nextCol = 1; nextRow++; }
            }
            usedCoordinates.add(`${row},${col}`);
            placeSpace.run(floor.id, row, col, space.id);
        }
        const floorHeight = db.prepare(`SELECT COALESCE(MAX(grid_row), 1) AS rows FROM parking_spaces WHERE floor_id = ?`).get(floor.id).rows;
        if (floorHeight > parking.rows) db.prepare(`UPDATE parking_floors SET rows = ? WHERE id = ?`).run(floorHeight, floor.id);
        db.prepare(`UPDATE active_cars SET floor_id = ? WHERE parking_id = ? AND floor_id IS NULL AND space_number IS NOT NULL`)
            .run(floor.id, parking.id);
        const oldCells = db.prepare(`SELECT grid_row, grid_col, cell_type FROM parking_grid_cells WHERE parking_id = ?`).all(parking.id);
        const insertCell = db.prepare(`
            INSERT OR IGNORE INTO parking_floor_grid_cells (floor_id, grid_row, grid_col, cell_type)
            VALUES (?, ?, ?, ?)
        `);
        for (const cell of oldCells) insertCell.run(floor.id, cell.grid_row, cell.grid_col, cell.cell_type);
    }
});
initializeFloors();

db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_parking_spaces_floor_grid_position
    ON parking_spaces (floor_id, grid_row, grid_col)
    WHERE floor_id IS NOT NULL AND grid_row IS NOT NULL AND grid_col IS NOT NULL
`).run();

app.post('/ee', auth, (req, res) => {
    const { type } = req.body;
    const plate =
        typeof req.body.plate === "string"
            ? req.body.plate.trim().toUpperCase()
            : "";

    const parking = req.parking;

    if (!plate) {
        return res.status(400).json({
            error: "Plate is required"
        });
    }

    if (type !== "entry" && type !== "exit") {
        return res.status(400).json({
            error: "Invalid type"
        });
    }

    // Giriş ve çıkış işlemlerini atomik yap.
    const processEntry = db.transaction(() => {
        const alreadyInside = db.prepare(`
            SELECT id
            FROM active_cars
            WHERE plate = ? AND parking_id = ?
        `).get(plate, parking.id);

        if (alreadyInside) {
            return {
                status: 400,
                body: { error: "Car already inside" }
            };
        }

        const spaceNumber = Number(req.body.spaceNumber);

        if (
            !Number.isSafeInteger(spaceNumber) ||
            spaceNumber < 1
        ) {
            return {
                status: 400,
                body: {
                    error: "A valid spaceNumber is required"
                }
            };
        }

        const space = db.prepare(`
            SELECT id, is_occupied, floor_id
            FROM parking_spaces
            WHERE parking_id = ? AND space_number = ?
        `).get(parking.id, spaceNumber);

        if (!space) {
            return {
                status: 404,
                body: { error: "Parking space not found" }
            };
        }

        if (space.is_occupied === 1) {
            return {
                status: 409,
                body: { error: "Parking space is occupied" }
            };
        }

        const entryTime = new Date().toISOString();

        // Boş yeri koşullu güncelle.
        const updatedSpace = db.prepare(`
            UPDATE parking_spaces
            SET is_occupied = 1,
                plate = ?,
                updated_at = ?
            WHERE id = ? AND is_occupied = 0
        `).run(plate, entryTime, space.id);

        if (updatedSpace.changes !== 1) {
            return {
                status: 409,
                body: { error: "Parking space is occupied" }
            };
        }

        db.prepare(`
            INSERT INTO active_cars
                (plate, parking_id, entry_time, space_number, floor_id)
            VALUES (?, ?, ?, ?, ?)
        `).run(plate, parking.id, entryTime, spaceNumber, space.floor_id);

        db.prepare(`
            UPDATE parkings
            SET current_cars = current_cars + 1
            WHERE id = ?
        `).run(parking.id);

        const currentCars = db.prepare(`
            SELECT current_cars
            FROM parkings
            WHERE id = ?
        `).get(parking.id).current_cars;

        return {
            status: 200,
            body: {
                message: "Entry successful",
                plate,
                parkingId: parking.id,
                spaceNumber,
                currentCars
            }
        };
    });

    const processExit = db.transaction(() => {
        const car = db.prepare(`
            SELECT id, space_number
            FROM active_cars
            WHERE plate = ? AND parking_id = ?
        `).get(plate, parking.id);

        if (!car) {
            return {
                status: 400,
                body: { error: "Car not inside" }
            };
        }

        // Yeni sisteme kayıtlı araçların park yerini boşalt.
        if (car.space_number !== null) {
            const releasedSpace = db.prepare(`
                UPDATE parking_spaces
                SET is_occupied = 0,
                    plate = NULL,
                    updated_at = ?
                WHERE parking_id = ?
                  AND space_number = ?
                  AND is_occupied = 1
                  AND plate = ?
            `).run(
                new Date().toISOString(),
                parking.id,
                car.space_number,
                plate
            );

            if (releasedSpace.changes !== 1) {
                throw new Error(
                    "Parking space state is inconsistent"
                );
            }
        }

        db.prepare(`
            DELETE FROM active_cars WHERE id = ?
        `).run(car.id);

        db.prepare(`
            UPDATE parkings
            SET current_cars = MAX(0, current_cars - 1)
            WHERE id = ?
        `).run(parking.id);

        const currentCars = db.prepare(`
            SELECT current_cars
            FROM parkings
            WHERE id = ?
        `).get(parking.id).current_cars;

        return {
            status: 200,
            body: {
                message: "Exit successful",
                plate,
                parkingId: parking.id,
                spaceNumber: car.space_number,
                currentCars
            }
        };
    });

    try {
        const result = type === "entry"
            ? processEntry()
            : processExit();

        return res.status(result.status).json(result.body);
    } catch (error) {
        console.error("Entry/exit error:", error);

        return res.status(500).json({
            error: "Could not process vehicle movement"
        });
    }
});




app.get('/parkings', (req, res) => {
    const parkings = db.prepare(`
        SELECT
            p.id,
            p.name,
            p.total_spaces,
            COUNT(s.id) AS tracked_spaces,
            COALESCE(SUM(s.is_occupied), 0) AS occupied_spaces
        FROM parkings p
        LEFT JOIN parking_spaces s
            ON s.parking_id = p.id
        GROUP BY p.id
        ORDER BY p.id ASC
    `).all();

    const data = parkings.map(p => {
        const totalSpaces = p.total_spaces;
        const occupiedSpaces = p.occupied_spaces;
        const freeSpaces = Math.max(
            0,
            totalSpaces - occupiedSpaces
        );

        const occupancyRate = totalSpaces > 0
            ? (occupiedSpaces / totalSpaces) * 100
            : 0;

        return {
            id: p.id,
            name: p.name,
            totalSpaces,
            trackedSpaces: p.tracked_spaces,
            occupiedSpaces,
            freeSpaces,
            occupancyRate: Number(occupancyRate.toFixed(1)),
            occupancyText: "%" + occupancyRate.toFixed(1),
            status:
                p.tracked_spaces !== totalSpaces
                    ? "incomplete"
                    : freeSpaces === 0
                        ? "full"
                        : "available"
        };
    });

    res.json(data);
});



function getFloorLayoutData(parkingId, floorId) {
    const parking = db.prepare(`SELECT id, name, total_spaces FROM parkings WHERE id = ?`).get(parkingId);
    if (!parking) return null;
    const floor = db.prepare(`SELECT id, name, floor_order, rows, cols FROM parking_floors WHERE id = ? AND parking_id = ?`).get(floorId, parkingId);
    if (!floor) return null;
    const spaces = db.prepare(`
        SELECT grid_row, grid_col, space_number, is_occupied
        FROM parking_spaces WHERE parking_id = ? AND floor_id = ?
    `).all(parkingId, floorId);
    const specialCells = db.prepare(`
        SELECT grid_row, grid_col, cell_type
        FROM parking_floor_grid_cells WHERE floor_id = ?
    `).all(floorId);
    const cellMap = new Map();
    for (const space of spaces) {
        cellMap.set(`${space.grid_row},${space.grid_col}`, {
            row: space.grid_row, col: space.grid_col, type: 'space',
            number: space.space_number, isOccupied: space.is_occupied === 1
        });
    }
    for (const cell of specialCells) {
        cellMap.set(`${cell.grid_row},${cell.grid_col}`, {
            row: cell.grid_row, col: cell.grid_col, type: cell.cell_type,
            number: null, isOccupied: false
        });
    }
    const cells = [];
    for (let row = 1; row <= floor.rows; row++) {
        for (let col = 1; col <= floor.cols; col++) {
            cells.push(cellMap.get(`${row},${col}`) || { row, col, type: 'blank', number: null, isOccupied: false });
        }
    }
    const floorSpaces = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(is_occupied), 0) AS occupied FROM parking_spaces WHERE parking_id = ? AND floor_id = ?`).get(parkingId, floorId);
    return {
        parkingId: parking.id, name: parking.name,
        floorId: floor.id, floorName: floor.name, floorOrder: floor.floor_order,
        rows: floor.rows, cols: floor.cols,
        totalSpaces: floorSpaces.total, occupiedSpaces: floorSpaces.occupied,
        freeSpaces: floorSpaces.total - floorSpaces.occupied,
        occupancyRate: floorSpaces.total ? Number((floorSpaces.occupied / floorSpaces.total * 100).toFixed(1)) : 0,
        cells
    };
}

function saveFloorLayout(parkingId, floorId, reqBody) {
    const { rows, cols, cells } = reqBody;
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 1 || cols < 1 || rows > 30 || cols > 30 || rows * cols > 400) {
        return { status: 400, body: { error: 'Rows and columns must be between 1 and 30, with at most 400 cells' } };
    }
    if (!Array.isArray(cells) || cells.length !== rows * cols) return { status: 400, body: { error: 'Every grid cell must be included' } };
    const seen = new Set();
    let spaceCount = 0;
    for (const cell of cells) {
        if (!cell || !Number.isSafeInteger(cell.row) || !Number.isSafeInteger(cell.col) || cell.row < 1 || cell.row > rows || cell.col < 1 || cell.col > cols || !['space', 'column', 'road', 'blank'].includes(cell.type)) {
            return { status: 400, body: { error: 'Invalid grid cell' } };
        }
        const key = `${cell.row},${cell.col}`;
        if (seen.has(key)) return { status: 400, body: { error: 'Duplicate grid cell' } };
        seen.add(key);
        if (cell.type === 'space') spaceCount++;
    }
    if (spaceCount < 1) return { status: 400, body: { error: 'The layout must contain at least one parking space' } };

    const saveLayout = db.transaction(() => {
        const floor = db.prepare(`SELECT id FROM parking_floors WHERE id = ? AND parking_id = ?`).get(floorId, parkingId);
        if (!floor) return { status: 404, body: { error: 'Parking floor not found' } };
        const activeCars = db.prepare(`SELECT COUNT(*) AS count FROM active_cars WHERE parking_id = ? AND floor_id = ?`).get(parkingId, floorId).count;
        const occupiedSpaces = db.prepare(`SELECT COUNT(*) AS count FROM parking_spaces WHERE parking_id = ? AND floor_id = ? AND is_occupied = 1`).get(parkingId, floorId).count;
        if (activeCars > 0 || occupiedSpaces > 0) return { status: 409, body: { error: 'Empty this floor before changing its layout' } };

        const nextNumber = db.prepare(`SELECT COALESCE(MAX(space_number), 0) + 1 AS next FROM parking_spaces WHERE parking_id = ? AND floor_id != ?`).get(parkingId, floorId).next;
        db.prepare(`DELETE FROM parking_spaces WHERE parking_id = ? AND floor_id = ?`).run(parkingId, floorId);
        db.prepare(`DELETE FROM parking_floor_grid_cells WHERE floor_id = ?`).run(floorId);
        const insertSpace = db.prepare(`INSERT INTO parking_spaces (parking_id, floor_id, space_number, is_occupied, grid_row, grid_col) VALUES (?, ?, ?, 0, ?, ?)`);
        const insertSpecial = db.prepare(`INSERT INTO parking_floor_grid_cells (floor_id, grid_row, grid_col, cell_type) VALUES (?, ?, ?, ?)`);
        let number = nextNumber;
        for (const cell of [...cells].sort((a, b) => a.row - b.row || a.col - b.col)) {
            if (cell.type === 'space') insertSpace.run(parkingId, floorId, number++, cell.row, cell.col);
            else insertSpecial.run(floorId, cell.row, cell.col, cell.type);
        }
        db.prepare(`UPDATE parking_floors SET rows = ?, cols = ? WHERE id = ?`).run(rows, cols, floorId);
        const totalSpaces = db.prepare(`SELECT COUNT(*) AS count FROM parking_spaces WHERE parking_id = ?`).get(parkingId).count;
        const currentCars = db.prepare(`SELECT COUNT(*) AS count FROM active_cars WHERE parking_id = ?`).get(parkingId).count;
        db.prepare(`UPDATE parkings SET total_spaces = ?, current_cars = ? WHERE id = ?`).run(totalSpaces, currentCars, parkingId);
        return { status: 200, body: { message: 'Parking floor layout saved', parkingId, floorId, rows, cols, totalSpaces: spaceCount, parkingTotalSpaces: totalSpaces } };
    });
    try { return saveLayout(); }
    catch (error) {
        console.error('Parking floor layout save error:', error);
        return { status: 500, body: { error: 'Could not save parking floor layout' } };
    }
}

app.get('/parkings/:id/floors', (req, res) => {
    const parkingId = Number(req.params.id);
    if (!Number.isSafeInteger(parkingId) || parkingId < 1) return res.status(400).json({ error: 'Invalid parking ID' });
    const parking = db.prepare(`SELECT id, name, total_spaces FROM parkings WHERE id = ?`).get(parkingId);
    if (!parking) return res.status(404).json({ error: 'Parking not found' });
    const floors = db.prepare(`
        SELECT f.id, f.name, f.floor_order, f.rows, f.cols,
               COUNT(s.id) AS total_spaces, COALESCE(SUM(s.is_occupied), 0) AS occupied_spaces
        FROM parking_floors f
        LEFT JOIN parking_spaces s ON s.floor_id = f.id AND s.parking_id = f.parking_id
        WHERE f.parking_id = ?
        GROUP BY f.id
        ORDER BY f.floor_order, f.id
    `).all(parkingId).map(floor => {
        const totalSpaces = floor.total_spaces;
        const occupiedSpaces = floor.occupied_spaces;
        const freeSpaces = totalSpaces - occupiedSpaces;
        return {
            id: floor.id, name: floor.name, order: floor.floor_order,
            rows: floor.rows, cols: floor.cols, totalSpaces, occupiedSpaces, freeSpaces,
            occupancyRate: totalSpaces ? Number((occupiedSpaces / totalSpaces * 100).toFixed(1)) : 0
        };
    });
    res.json({ parkingId, name: parking.name, totalSpaces: parking.total_spaces, floors });
});

app.post('/parkings/:id/floors', auth, (req, res) => {
    const parkingId = Number(req.params.id);
    if (!Number.isSafeInteger(parkingId) || parkingId < 1 || req.parking.id !== parkingId) return res.status(403).json({ error: 'API key does not belong to this parking' });
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const rows = Number(req.body.rows);
    const cols = Number(req.body.cols);
    if (!name || name.length > 60 || !Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 1 || cols < 1 || rows > 30 || cols > 30 || rows * cols > 400) {
        return res.status(400).json({ error: 'A floor name and valid rows/cols (max 30 and 400 cells) are required' });
    }
    try {
        const result = db.transaction(() => {
            const floorOrder = db.prepare(`SELECT COALESCE(MAX(floor_order), 0) + 1 AS next FROM parking_floors WHERE parking_id = ?`).get(parkingId).next;
            const floorResult = db.prepare(`INSERT INTO parking_floors (parking_id, name, floor_order, rows, cols) VALUES (?, ?, ?, ?, ?)`).run(parkingId, name, floorOrder, rows, cols);
            const floorId = Number(floorResult.lastInsertRowid);
            let nextNumber = db.prepare(`SELECT COALESCE(MAX(space_number), 0) + 1 AS next FROM parking_spaces WHERE parking_id = ?`).get(parkingId).next;
            const insertSpace = db.prepare(`INSERT INTO parking_spaces (parking_id, floor_id, space_number, grid_row, grid_col) VALUES (?, ?, ?, ?, ?)`);
            for (let row = 1; row <= rows; row++) for (let col = 1; col <= cols; col++) insertSpace.run(parkingId, floorId, nextNumber++, row, col);
            const totalSpaces = db.prepare(`SELECT COUNT(*) AS count FROM parking_spaces WHERE parking_id = ?`).get(parkingId).count;
            db.prepare(`UPDATE parkings SET total_spaces = ? WHERE id = ?`).run(totalSpaces, parkingId);
            return { floorId, floorOrder, totalSpaces };
        })();
        res.status(201).json({ message: 'Parking floor created', ...result });
    } catch (error) {
        if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'A floor with this name already exists' });
        console.error('Create floor error:', error);
        res.status(500).json({ error: 'Could not create parking floor' });
    }
});

app.delete('/parkings/:id/floors/:floorId', auth, (req, res) => {
    const parkingId = Number(req.params.id);
    const floorId = Number(req.params.floorId);
    if (!Number.isSafeInteger(parkingId) || req.parking.id !== parkingId) return res.status(403).json({ error: 'API key does not belong to this parking' });
    const floor = db.prepare(`SELECT id, name FROM parking_floors WHERE id = ? AND parking_id = ?`).get(floorId, parkingId);
    if (!floor) return res.status(404).json({ error: 'Parking floor not found' });
    const floorCount = db.prepare(`SELECT COUNT(*) AS count FROM parking_floors WHERE parking_id = ?`).get(parkingId).count;
    if (floorCount <= 1) return res.status(400).json({ error: 'An parking must keep at least one floor' });
    const activeCars = db.prepare(`SELECT COUNT(*) AS count FROM active_cars WHERE parking_id = ? AND floor_id = ?`).get(parkingId, floorId).count;
    const occupied = db.prepare(`SELECT COUNT(*) AS count FROM parking_spaces WHERE parking_id = ? AND floor_id = ? AND is_occupied = 1`).get(parkingId, floorId).count;
    if (activeCars || occupied) return res.status(409).json({ error: 'Remove all cars from this floor before deleting it' });
    db.transaction(() => {
        db.prepare(`DELETE FROM parking_floor_grid_cells WHERE floor_id = ?`).run(floorId);
        db.prepare(`DELETE FROM parking_spaces WHERE parking_id = ? AND floor_id = ?`).run(parkingId, floorId);
        db.prepare(`DELETE FROM parking_floors WHERE id = ?`).run(floorId);
        const remainingFloors = db.prepare(`SELECT id FROM parking_floors WHERE parking_id = ? ORDER BY floor_order, id`).all(parkingId);
        const reorderFloor = db.prepare(`UPDATE parking_floors SET floor_order = ? WHERE id = ?`);
        remainingFloors.forEach((item, index) => reorderFloor.run(index + 1, item.id));
        const totalSpaces = db.prepare(`SELECT COUNT(*) AS count FROM parking_spaces WHERE parking_id = ?`).get(parkingId).count;
        const currentCars = db.prepare(`SELECT COUNT(*) AS count FROM active_cars WHERE parking_id = ?`).get(parkingId).count;
        db.prepare(`UPDATE parkings SET total_spaces = ?, current_cars = ? WHERE id = ?`).run(totalSpaces, currentCars, parkingId);
    })();
    res.json({ message: 'Parking floor deleted', floorId });
});

app.get('/parkings/:id/floors/:floorId/layout', (req, res) => {
    const parkingId = Number(req.params.id);
    const floorId = Number(req.params.floorId);
    if (!Number.isSafeInteger(parkingId) || parkingId < 1 || !Number.isSafeInteger(floorId) || floorId < 1) return res.status(400).json({ error: 'Invalid parking or floor ID' });
    const layout = getFloorLayoutData(parkingId, floorId);
    if (!layout) return res.status(404).json({ error: 'Parking or floor not found' });
    res.json(layout);
});

app.put('/parkings/:id/floors/:floorId/layout', auth, (req, res) => {
    const parkingId = Number(req.params.id);
    const floorId = Number(req.params.floorId);
    if (!Number.isSafeInteger(parkingId) || !Number.isSafeInteger(floorId) || req.parking.id !== parkingId) return res.status(403).json({ error: 'API key does not belong to this parking' });
    const result = saveFloorLayout(parkingId, floorId, req.body);
    res.status(result.status).json(result.body);
});

// Eski istemciler için varsayılan kat endpoint'leri.
app.get('/parkings/:id/layout', (req, res) => {
    const parkingId = Number(req.params.id);
    const floor = db.prepare(`SELECT id FROM parking_floors WHERE parking_id = ? ORDER BY floor_order, id LIMIT 1`).get(parkingId);
    if (!floor) return res.status(404).json({ error: 'Parking floor not found' });
    const layout = getFloorLayoutData(parkingId, floor.id);
    if (!layout) return res.status(404).json({ error: 'Parking not found' });
    res.json(layout);
});

app.put('/parkings/:id/layout', auth, (req, res) => {
    const parkingId = Number(req.params.id);
    if (!Number.isSafeInteger(parkingId) || req.parking.id !== parkingId) return res.status(403).json({ error: 'API key does not belong to this parking' });
    const floor = db.prepare(`SELECT id FROM parking_floors WHERE parking_id = ? ORDER BY floor_order, id LIMIT 1`).get(parkingId);
    if (!floor) return res.status(404).json({ error: 'Parking floor not found' });
    const result = saveFloorLayout(parkingId, floor.id, req.body);
    res.status(result.status).json(result.body);
});

app.get('/parkings/:id/spaces', (req, res) => {
    const parkingId = Number(req.params.id);

    if (!Number.isSafeInteger(parkingId) || parkingId < 1) {
        return res.status(400).json({
            error: "Invalid parking ID"
        });
    }

    const parking = db.prepare(`
        SELECT id, name, total_spaces
        FROM parkings
        WHERE id = ?
    `).get(parkingId);

    if (!parking) {
        return res.status(404).json({
            error: "Parking not found"
        });
    }

    const spaces = db.prepare(`
        SELECT space_number, is_occupied, updated_at, floor_id
        FROM parking_spaces
        WHERE parking_id = ?
        ORDER BY space_number ASC
    `).all(parkingId);

    const occupiedSpaces = spaces.filter(
        space => space.is_occupied === 1
    ).length;

    res.json({
        parkingId: parking.id,
        name: parking.name,
        totalSpaces: parking.total_spaces,
        occupiedSpaces,
        freeSpaces: parking.total_spaces - occupiedSpaces,
        spaces: spaces.map(space => ({
            number: space.space_number,
            floorId: space.floor_id,
            isOccupied: space.is_occupied === 1,
            updatedAt: space.updated_at
        }))
    });
});


function generateApiKey() {
    return `pk_${crypto.randomBytes(32).toString('hex')}`;
}

app.post('/addparking', (req, res) => {

    const { name, totalSpaces } = req.body;

    const adminKey = req.headers['x-admin-key'];

    if (!adminKey) {
        return res.status(401).json({
            error: "Admin key missing"
        });
    }

    const providedHash = crypto
        .createHash('sha256')
        .update(adminKey)
        .digest('hex');

    const expectedHash = process.env.ADD_PARKING_API_KEY_HASH;

    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
        console.error('ADD_PARKING_API_KEY_HASH is missing or invalid');
        return res.status(503).json({ error: 'Parking creation is not configured' });
    }

    const valid = crypto.timingSafeEqual(
        Buffer.from(providedHash, 'hex'),
        Buffer.from(expectedHash, 'hex')
    );

    if (!valid) {
        return res.status(403).json({
            error: "Unauthorized"
        });
    }

    
    if (
        typeof name !== "string" ||
        !name.trim() ||
        !Number.isSafeInteger(totalSpaces) ||
        totalSpaces < 1
    ) {
        return res.status(400).json({
            error: "Name and a positive integer totalSpaces are required"
        });
    }


    const apiKey = generateApiKey();

    const cols = Math.max(1, Math.min(5, totalSpaces));
    const rows = Math.max(1, Math.ceil(totalSpaces / cols));
    try {
        const parkingId = db.transaction(() => {
            const result = db.prepare(`INSERT INTO parkings (name, total_spaces, current_cars, api_key) VALUES (?, ?, 0, ?)`)
                .run(name.trim(), totalSpaces, apiKey);
            const id = Number(result.lastInsertRowid);
            db.prepare(`INSERT INTO parking_layouts (parking_id, rows, cols) VALUES (?, ?, ?)`)
                .run(id, rows, cols);
            const floor = db.prepare(`INSERT INTO parking_floors (parking_id, name, floor_order, rows, cols) VALUES (?, 'Zemin Kat', 1, ?, ?)`)
                .run(id, rows, cols);
            const insertSpace = db.prepare(`INSERT INTO parking_spaces (parking_id, floor_id, space_number, grid_row, grid_col) VALUES (?, ?, ?, ?, ?)`);
            for (let number = 1; number <= totalSpaces; number++) {
                insertSpace.run(id, Number(floor.lastInsertRowid), number, Math.floor((number - 1) / cols) + 1, ((number - 1) % cols) + 1);
            }
            return id;
        })();
        res.status(201).json({ id: parkingId, apiKey, message: 'Parking created' });
    } catch (error) {
        console.error('Create parking error:', error);
        res.status(500).json({ error: 'Could not create parking' });
    }
});

app.post('/removeparking', (req, res) => {

    const { parkingId } = req.body;

    const adminKey = req.headers['x-admin-key'];

    const expectedHash = process.env.ADD_PARKING_API_KEY_HASH;

    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
        console.error('ADD_PARKING_API_KEY_HASH is missing or invalid');
        return res.status(503).json({ error: 'Parking management is not configured' });
    }

    const providedHash = require('crypto')
        .createHash('sha256')
        .update(adminKey || "")
        .digest('hex');

    if (providedHash !== expectedHash) {
        return res.status(403).json({
            error: "Unauthorized"
        });
    }

    const parking = db.prepare(`
        SELECT * FROM parkings WHERE id = ?
    `).get(parkingId);

    if (!parking) {
        return res.status(404).json({
            error: "Parking not found"
        });
    }

    db.prepare(`
        DELETE FROM active_cars WHERE parking_id = ?
    `).run(parkingId);

    db.prepare(`DELETE FROM parking_grid_cells WHERE parking_id = ?`).run(parkingId);
    db.prepare(`DELETE FROM parking_floor_grid_cells WHERE floor_id IN (SELECT id FROM parking_floors WHERE parking_id = ?)`).run(parkingId);
    db.prepare(`DELETE FROM parking_floors WHERE parking_id = ?`).run(parkingId);
    db.prepare(`DELETE FROM parking_layouts WHERE parking_id = ?`).run(parkingId);
    db.prepare(`DELETE FROM parking_spaces WHERE parking_id = ?`).run(parkingId);

    db.prepare(`
        DELETE FROM parkings WHERE id = ?
    `).run(parkingId);

    res.json({
        message: "Parking deleted successfully"
    });
});

function auth(req, res, next) {

    const key = req.headers['x-api-key'];

    if (!key) {
        return res.status(401).json({
            error: "API key missing"
        });
    }

    const parking = db.prepare(`
        SELECT * FROM parkings WHERE api_key = ?
    `).get(key);

    if (!parking) {
        return res.status(403).json({
            error: "Invalid API key"
        });
    }

    req.parking = parking; 
    next();
}



app.put('/spaces/:spaceNumber', auth, (req, res) => {
    const spaceNumber = Number(req.params.spaceNumber);
    const { isOccupied } = req.body;
    const parking = req.parking;

    if (!Number.isSafeInteger(spaceNumber) || spaceNumber < 1) {
        return res.status(400).json({
            error: "Invalid space number"
        });
    }

    if (typeof isOccupied !== "boolean") {
        return res.status(400).json({
            error: "isOccupied must be true or false"
        });
    }

    // Plaka verilmişse normalleştir.
    const plateProvided = Object.prototype.hasOwnProperty.call(
        req.body,
        "plate"
    );

    if (
        plateProvided &&
        (typeof req.body.plate !== "string" || !req.body.plate.trim())
    ) {
        return res.status(400).json({
            error: "Invalid plate"
        });
    }

    const requestedPlate = plateProvided
        ? req.body.plate.trim().toUpperCase()
        : null;

    const updatedAt = new Date().toISOString();

    const updateSpace = db.transaction(() => {
        const space = db.prepare(`
            SELECT id, space_number, is_occupied, plate, floor_id
            FROM parking_spaces
            WHERE parking_id = ? AND space_number = ?
        `).get(parking.id, spaceNumber);

        if (!space) {
            return {
                status: 404,
                body: { error: "Parking space not found" }
            };
        }

        if (isOccupied) {
            // Zaten dolu bir yerin plakası gönderilmediyse mevcut plakayı koru.
            const normalizedPlate = requestedPlate || (
                space.is_occupied ? space.plate : null
            );

            if (!normalizedPlate) {
                return {
                    status: 400,
                    body: {
                        error: "A plate is required when occupying a space"
                    }
                };
            }

            // Dolu bir yerdeki aracı başka bir araçla sessizce değiştirme.
            if (
                space.is_occupied === 1 &&
                space.plate &&
                space.plate !== normalizedPlate
            ) {
                return {
                    status: 409,
                    body: {
                        error: "Space is occupied by another plate"
                    }
                };
            }

            // Aynı plaka başka bir yerde veya aktif araç kaydında mı?
            const carByPlate = db.prepare(`
                SELECT id, space_number
                FROM active_cars
                WHERE parking_id = ? AND plate = ?
            `).get(parking.id, normalizedPlate);

            if (
                carByPlate &&
                carByPlate.space_number !== spaceNumber
            ) {
                return {
                    status: 409,
                    body: {
                        error: "This car is already registered in another space"
                    }
                };
            }

            const carAtSpace = db.prepare(`
                SELECT id, plate
                FROM active_cars
                WHERE parking_id = ? AND space_number = ?
            `).get(parking.id, spaceNumber);

            if (
                carAtSpace &&
                carAtSpace.plate !== normalizedPlate
            ) {
                return {
                    status: 409,
                    body: {
                        error: "Another active car is registered in this space"
                    }
                };
            }

            // Önce park yerini güncelle.
            db.prepare(`
                UPDATE parking_spaces
                SET is_occupied = 1,
                    plate = ?,
                    updated_at = ?
                WHERE id = ?
            `).run(normalizedPlate, updatedAt, space.id);

            // Araç henüz kayıtlı değilse aktif araç kaydını da oluştur.
            if (!carByPlate) {
                db.prepare(`
                    INSERT INTO active_cars
                        (plate, parking_id, entry_time, space_number, floor_id)
                    VALUES (?, ?, ?, ?, ?)
                `).run(
                    normalizedPlate,
                    parking.id,
                    updatedAt,
                    spaceNumber,
                    space.floor_id
                );
            }
        } else {
            // Park yerini boşalt.
            db.prepare(`
                UPDATE parking_spaces
                SET is_occupied = 0,
                    plate = NULL,
                    updated_at = ?
                WHERE id = ?
            `).run(updatedAt, space.id);

            // Bu yere bağlı aktif araç kaydını da kaldır.
            db.prepare(`
                DELETE FROM active_cars
                WHERE parking_id = ? AND space_number = ?
            `).run(parking.id, spaceNumber);

            // Eski kayıtlarda space_number NULL olabilir.
            if (space.plate) {
                db.prepare(`
                    DELETE FROM active_cars
                    WHERE parking_id = ?
                      AND plate = ?
                      AND space_number IS NULL
                `).run(parking.id, space.plate);
            }
        }

        // Sayaç, aktif araç kayıtlarından yeniden hesaplanır.
        const currentCars = db.prepare(`
            SELECT COUNT(*) AS count
            FROM active_cars
            WHERE parking_id = ?
        `).get(parking.id).count;

        db.prepare(`
            UPDATE parkings
            SET current_cars = ?
            WHERE id = ?
        `).run(currentCars, parking.id);

        return {
            status: 200,
            body: {
                message: "Parking space updated",
                parkingId: parking.id,
                spaceNumber,
                isOccupied,
                plate: isOccupied
                    ? (requestedPlate || space.plate)
                    : null,
                currentCars,
                updatedAt
            }
        };
    });

    try {
        const result = updateSpace();
        return res.status(result.status).json(result.body);
    } catch (error) {
        console.error("Parking space update error:", error);

        return res.status(500).json({
            error: "Could not update parking space"
        });
    }
});



app.listen(3000, () => {
    console.log('Server running on port 3000');
});

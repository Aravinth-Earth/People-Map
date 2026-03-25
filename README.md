# People Map

People Map is a graph-first web app for creating and exploring a live map of people and relationships.

## Stack

- Backend: FastAPI + SQLite
- Frontend: React + TypeScript + React Flow

## Local setup

### Backend dependencies

```powershell
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

### Frontend dependencies

```powershell
cd frontend
npm install
```

## Run locally

### Full app

```powershell
.venv\Scripts\python.exe .\start_people_map.py
```

This starts backend and frontend together and writes one shared session log file for the full run.

### Backend only

```powershell
.venv\Scripts\python.exe -m uvicorn backend.main:app --reload
```

### Frontend only

```powershell
cd frontend
npm run dev
```

## Notes

- Start the backend first, then the frontend.
- The frontend currently calls `http://127.0.0.1:8000` directly.
- Local app data and logs are intentionally not committed.

## Session logs

Each launcher session writes a fresh local log file to:

```text
logs/session-YYYYMMDD-HHMMSS.log
```

The log includes:

- backend startup
- database initialization
- API request start/completion
- CRUD operations
- client-side events forwarded from the frontend when the backend is reachable

Old session logs are rotated automatically. The app currently keeps the most recent 20 `session-*.log` files.

All session logs use local timestamps with millisecond precision.

## License

MIT. See [LICENSE](LICENSE).

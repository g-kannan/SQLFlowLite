# SQLFlowLite

Dockerized SQL lineage diagram app. Paste SQL or upload `.sql` files and render
column-level or table-level lineage inferred from SQL text only. The app does
not connect to any database or source system. Column lineage is the default and
can be viewed grouped by table/query result or expanded to individual columns.

## Stack

- Backend: FastAPI, SQLGlot
- Frontend: React, Vite, TypeScript
- Diagram: React Flow
- Layout: Dagre
- Runtime: Docker Compose

## Run

Start both frontend and backend together:

```powershell
docker compose up --build
```

Open http://localhost:5173 after the containers are up.

This Compose setup runs the API with Uvicorn reload and the web app with the Vite dev server, so source changes should appear without rebuilding the images.

API health check:

```powershell
Invoke-RestMethod http://localhost:8000/health
```

## API

`POST /parse`

```json
{
  "sql": "INSERT INTO mart.sales SELECT * FROM raw.orders",
  "dialect": "postgres",
  "level": "column"
}
```

`POST /parse-multi`

```json
{
  "dialect": "postgres",
  "level": "table",
  "files": [
    {
      "filename": "sales.sql",
      "sql": "CREATE TABLE mart.sales AS SELECT * FROM raw.orders"
    }
  ]
}
```

Both endpoints return:

```json
{
  "level": "column",
  "nodes": [],
  "edges": [],
  "statements": [],
  "errors": []
}
```

## Local Development

Backend:

```powershell
cd api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Frontend:

```powershell
cd web
npm install
npm run dev
```

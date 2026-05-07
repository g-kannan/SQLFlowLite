from __future__ import annotations

from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .lineage import ParsedStatement, build_column_graph, build_graph, parse_lineage


LineageLevel = Literal["column", "table"]


class ParseRequest(BaseModel):
    sql: str = Field(..., min_length=1)
    dialect: str | None = None
    level: LineageLevel = "column"


class SqlFile(BaseModel):
    filename: str
    sql: str = Field(..., min_length=1)


class ParseMultiRequest(BaseModel):
    files: list[SqlFile] = Field(..., min_length=1)
    dialect: str | None = None
    level: LineageLevel = "column"


app = FastAPI(title="SQLFlowLite API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/parse")
def parse(request: ParseRequest) -> dict[str, object]:
    statements, errors = parse_lineage(request.sql, request.dialect)
    graph = _build_graph(statements, request.level)
    return {
        **graph,
        "level": _normalized_level(request.level),
        "statements": [statement.__dict__ for statement in statements],
        "errors": errors,
    }


@app.post("/parse-multi")
def parse_multi(request: ParseMultiRequest) -> dict[str, object]:
    graph_statements: list[ParsedStatement] = []
    response_statements = []
    all_errors: list[dict[str, str]] = []

    for file in request.files:
        statements, errors = parse_lineage(file.sql, request.dialect)
        for statement in statements:
            graph_statements.append(statement)
            response_statements.append(
                {
                    **statement.__dict__,
                    "filename": file.filename,
                }
            )
        for error in errors:
            all_errors.append({"filename": file.filename, "message": error})

    graph = _build_graph(graph_statements, request.level)
    return {
        **graph,
        "level": _normalized_level(request.level),
        "statements": response_statements,
        "errors": all_errors,
    }


def _normalized_level(level: LineageLevel) -> LineageLevel:
    return "table" if level == "table" else "column"


def _build_graph(statements: list[ParsedStatement], level: LineageLevel) -> dict[str, list[dict[str, str]]]:
    if _normalized_level(level) == "table":
        return build_graph(statements)
    return build_column_graph(statements)

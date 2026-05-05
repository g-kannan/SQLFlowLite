from __future__ import annotations

from dataclasses import dataclass

import sqlglot
from sqlglot import exp
from sqlglot.lineage import lineage


@dataclass(frozen=True)
class ParsedStatement:
    index: int
    sql: str
    targets: list[str]
    sources: list[str]
    columns: list[dict[str, object]]


def parse_lineage(sql: str, dialect: str | None = None) -> tuple[list[ParsedStatement], list[str]]:
    """Extract table and column lineage from SQL text without touching a database."""
    errors: list[str] = []
    try:
        expressions = sqlglot.parse(sql, read=dialect or None)
    except Exception as exc:  # sqlglot raises dialect/parser-specific exceptions
        return [], [str(exc)]

    statements: list[ParsedStatement] = []
    for index, expression in enumerate(expressions):
        if expression is None:
            continue

        try:
            targets = sorted(_target_tables(expression))
            sources = sorted(_source_tables(expression, targets))
            if not targets and sources:
                targets = [f"query_result_{index + 1}"]

            statements.append(
                ParsedStatement(
                    index=index,
                    sql=expression.sql(dialect=dialect or None),
                    targets=targets,
                    sources=sources,
                    columns=_column_lineage(expression, targets, index, dialect),
                )
            )
        except Exception as exc:
            errors.append(f"Statement {index + 1}: {exc}")

    return statements, errors


def build_graph(statements: list[ParsedStatement]) -> dict[str, list[dict[str, str]]]:
    node_kinds: dict[str, str] = {}
    edge_pairs: set[tuple[str, str]] = set()

    for statement in statements:
        for source in statement.sources:
            node_kinds.setdefault(source, "source")

        for target in statement.targets:
            if target.startswith("query_result_"):
                node_kinds[target] = "result"
            else:
                previous = node_kinds.get(target)
                node_kinds[target] = "intermediate" if previous == "source" else "target"

        for target in statement.targets:
            for source in statement.sources:
                if source != target:
                    edge_pairs.add((source, target))

    nodes = [
        {
            "id": table_id,
            "label": _table_label(table_id),
            "kind": kind,
        }
        for table_id, kind in sorted(node_kinds.items())
    ]
    edges = [
        {
            "id": f"{source}->{target}",
            "source": source,
            "target": target,
        }
        for source, target in sorted(edge_pairs)
    ]
    return {"nodes": nodes, "edges": edges}


def build_column_graph(statements: list[ParsedStatement]) -> dict[str, list[dict[str, str]]]:
    node_kinds: dict[str, str] = {}
    edge_pairs: set[tuple[str, str]] = set()

    for statement in statements:
        for column in statement.columns:
            target = str(column["target"])
            node_kinds[target] = "result" if target.startswith("query_result_") else "target"

            for source in column["sources"]:
                source_id = str(source)
                previous = node_kinds.get(source_id)
                node_kinds[source_id] = "intermediate" if previous == "target" else "source"
                if source_id != target:
                    edge_pairs.add((source_id, target))

    nodes = [
        {
            "id": column_id,
            "label": _column_label(column_id),
            "kind": kind,
        }
        for column_id, kind in sorted(node_kinds.items())
    ]
    edges = [
        {
            "id": f"{source}->{target}",
            "source": source,
            "target": target,
        }
        for source, target in sorted(edge_pairs)
    ]
    return {"nodes": nodes, "edges": edges}


def _table_label(table_id: str) -> str:
    if table_id.startswith("query_result_"):
        suffix = table_id.removeprefix("query_result_")
        return "Query Result" if suffix == "1" else f"Query Result {suffix}"
    return table_id


def _column_label(column_id: str) -> str:
    if column_id.startswith("query_result_"):
        return column_id.replace("query_result_1.", "Query Result.")
    return column_id


def _column_lineage(
    expression: exp.Expression,
    targets: list[str],
    index: int,
    dialect: str | None,
) -> list[dict[str, object]]:
    query = _query_expression(expression)
    if not query or not hasattr(query, "selects"):
        return []

    target_table = targets[0] if targets else f"query_result_{index + 1}"
    target_columns = _target_column_names(expression, query)
    output_columns = [
        select.alias_or_name or f"column_{position + 1}"
        for position, select in enumerate(query.selects)
    ]

    if not target_columns:
        target_columns = output_columns
    if len(target_columns) < len(output_columns):
        target_columns = [*target_columns, *output_columns[len(target_columns) :]]

    columns: list[dict[str, object]] = []
    for position, output_column in enumerate(output_columns):
        target_column = target_columns[position] if position < len(target_columns) else output_column
        target_id = f"{target_table}.{target_column}"
        select = query.selects[position]

        if select.is_star:
            sources = sorted(f"{table}.*" for table in _source_tables(expression, set(targets)))
            edges = [{"source": source, "target": target_id} for source in sources]
        else:
            mapping = _source_column_mapping(query, output_column, target_id, dialect)
            sources = sorted(mapping["sources"])
            edges = mapping["edges"]

        columns.append(
            {
                "target": target_id,
                "sources": sources,
                "edges": edges,
                "expression": select.sql(dialect=dialect or None),
            }
        )

    return columns


def _query_expression(expression: exp.Expression) -> exp.Expression | None:
    if isinstance(expression, (exp.Create, exp.Insert)):
        return expression.expression
    if isinstance(expression, exp.Select):
        return expression
    if isinstance(expression, exp.Subqueryable):
        return expression
    return None


def _target_column_names(expression: exp.Expression, query: exp.Expression) -> list[str]:
    schema = None
    if isinstance(expression, exp.Insert) and isinstance(expression.this, exp.Schema):
        schema = expression.this
    elif isinstance(expression, exp.Create) and isinstance(expression.this, exp.Schema):
        schema = expression.this

    if schema is not None:
        return [column.name for column in schema.expressions if column.name]

    return [select.alias_or_name for select in query.selects if select.alias_or_name]


def _source_columns(query: exp.Expression, output_column: str, dialect: str | None) -> set[str]:
    return set(_source_column_mapping(query, output_column, output_column, dialect)["sources"])


def _source_column_mapping(
    query: exp.Expression,
    output_column: str,
    target_id: str,
    dialect: str | None,
) -> dict[str, object]:
    try:
        root = lineage(output_column, query, dialect=dialect or None)
    except Exception:
        return _fallback_column_mapping(query, output_column, target_id, dialect)

    sources: set[str] = set()
    edges: list[dict[str, str]] = []
    cte_names = _cte_name_map(query)

    def visit(node, parent_id: str) -> None:
        for downstream in node.downstream:
            downstream_id = _lineage_node_id(downstream, cte_names)
            if downstream_id:
                edges.append({"source": downstream_id, "target": parent_id})
                if isinstance(downstream.expression, exp.Table):
                    sources.add(downstream_id)
                visit(downstream, downstream_id)

    visit(root, target_id)

    if sources:
        return {"sources": sources, "edges": edges}

    return _fallback_column_mapping(query, output_column, target_id, dialect)


def _lineage_node_id(node, cte_names: dict[str, str]) -> str:
    column = node.name.split(".")[-1]
    if isinstance(node.expression, exp.Table):
        table = _qualified_table_name(node.expression)
        return f"{table}.{column}" if table and column else node.name

    if node.reference_node_name:
        source = cte_names.get(node.reference_node_name.lower(), node.reference_node_name.lower())
        return f"{source}.{column}" if column else source

    return node.name


def _cte_name_map(expression: exp.Expression) -> dict[str, str]:
    return {
        cte.alias_or_name.lower(): cte.alias_or_name.lower()
        for cte in expression.find_all(exp.CTE)
        if cte.alias_or_name
    }


def _cte_table_aliases(expression: exp.Expression) -> dict[str, str]:
    cte_names = _cte_name_map(expression)
    aliases: dict[str, str] = {}
    for table in expression.find_all(exp.Table):
        cte_name = cte_names.get(table.name.lower())
        if cte_name:
            aliases[table.alias_or_name.lower()] = cte_name
            aliases[table.name.lower()] = cte_name
    return aliases


def _cte_query(expression: exp.Expression, cte_name: str | None) -> exp.Expression | None:
    if not cte_name:
        return None
    for cte in expression.find_all(exp.CTE):
        if cte.alias_or_name.lower() == cte_name.lower():
            return cte.this
    return None


def _fallback_source_columns(query: exp.Expression, output_column: str) -> set[str]:
    alias_to_table = _table_aliases(query)
    primary_table = _primary_table(query)
    sources: set[str] = set()

    selected = next((select for select in query.selects if select.alias_or_name == output_column), None)
    if selected is None:
        return sources

    for column in selected.find_all(exp.Column):
        table = alias_to_table.get(column.table) or column.table
        if not table and len(alias_to_table) == 1:
            table = next(iter(alias_to_table.values()))
        if not table and primary_table:
            table = primary_table
        if table:
            sources.add(f"{table}.{column.name}")

    if not sources and selected.find(exp.Star):
        sources.update(f"{table}.*" for table in alias_to_table.values())
    return sources


def _fallback_column_mapping(
    query: exp.Expression,
    output_column: str,
    target_id: str,
    dialect: str | None,
) -> dict[str, object]:
    cte_aliases = _cte_table_aliases(query)
    selected = next((select for select in query.selects if select.alias_or_name == output_column), None)

    if selected is not None:
        columns = list(selected.find_all(exp.Column))
        if len(columns) == 1:
            source_column = columns[0]
            cte_name = cte_aliases.get(source_column.table.lower())
            cte_query = _cte_query(query, cte_name)
            if cte_query is not None:
                intermediate_id = f"{cte_name}.{source_column.name}"
                nested = _source_column_mapping(cte_query, source_column.name, intermediate_id, dialect)
                return {
                    "sources": nested["sources"],
                    "edges": [
                        {"source": intermediate_id, "target": target_id},
                        *nested["edges"],
                    ],
                }

    sources = _fallback_source_columns(query, output_column)
    return {
        "sources": sources,
        "edges": [{"source": source, "target": target_id} for source in sorted(sources)],
    }


def _target_tables(expression: exp.Expression) -> set[str]:
    targets: set[str] = set()

    if isinstance(expression, exp.Insert):
        table = expression.this
        if isinstance(table, exp.Schema):
            table = table.this
        targets.update(_table_names(table))
    elif isinstance(expression, exp.Create):
        targets.update(_table_names(expression.this))
    elif isinstance(expression, exp.Merge):
        targets.update(_table_names(expression.this))
    elif isinstance(expression, exp.Update):
        targets.update(_table_names(expression.this))
    elif isinstance(expression, exp.Delete):
        targets.update(_table_names(expression.this))

    return targets


def _source_tables(expression: exp.Expression, targets: set[str]) -> set[str]:
    cte_names = {
        cte.alias_or_name
        for cte in expression.find_all(exp.CTE)
        if cte.alias_or_name
    }

    sources: set[str] = set()
    for table in expression.find_all(exp.Table):
        name = _qualified_table_name(table)
        if not name or name in targets or name in cte_names:
            continue
        sources.add(name)
    return sources


def _table_names(expression: exp.Expression | None) -> set[str]:
    if expression is None:
        return set()
    if isinstance(expression, exp.Schema):
        expression = expression.this
    if isinstance(expression, exp.Table):
        name = _qualified_table_name(expression)
        return {name} if name else set()
    table = expression.find(exp.Table)
    if table is None:
        return set()
    name = _qualified_table_name(table)
    return {name} if name else set()


def _table_aliases(expression: exp.Expression) -> dict[str, str]:
    aliases: dict[str, str] = {}
    cte_names = {
        cte.alias_or_name
        for cte in expression.find_all(exp.CTE)
        if cte.alias_or_name
    }

    for table in expression.find_all(exp.Table):
        name = _qualified_table_name(table)
        if not name or name in cte_names:
            continue
        aliases[table.alias_or_name] = name
        aliases[table.name] = name
        aliases[name] = name
    return aliases


def _primary_table(expression: exp.Expression) -> str | None:
    from_clause = expression.args.get("from")
    table = from_clause.this if from_clause is not None else None
    if isinstance(table, exp.Table):
        return _qualified_table_name(table)
    return None


def _qualified_table_name(table: exp.Table) -> str:
    parts = [table.catalog, table.db, table.name]
    return ".".join(part for part in parts if part)

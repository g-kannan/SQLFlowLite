from app.lineage import build_column_graph, build_graph, parse_lineage


def test_insert_select_lineage() -> None:
    statements, errors = parse_lineage(
        "INSERT INTO mart.sales SELECT * FROM raw.orders",
        "spark",
    )

    assert errors == []
    assert statements[0].targets == ["mart.sales"]
    assert statements[0].sources == ["raw.orders"]

    graph = build_graph(statements)
    assert {"id": "raw.orders", "label": "raw.orders", "kind": "source"} in graph["nodes"]
    assert {"id": "mart.sales", "label": "mart.sales", "kind": "target"} in graph["nodes"]
    assert {"id": "raw.orders->mart.sales", "source": "raw.orders", "target": "mart.sales"} in graph["edges"]


def test_select_gets_result_node() -> None:
    statements, errors = parse_lineage("SELECT * FROM raw.orders", "spark")

    assert errors == []
    assert statements[0].targets == ["query_result_1"]
    assert statements[0].sources == ["raw.orders"]


def test_column_lineage_for_ctas() -> None:
    statements, errors = parse_lineage(
        """
        CREATE TABLE mart.sales AS
        SELECT o.order_id, o.customer_id, c.region
        FROM raw.orders o
        JOIN raw.customers c ON o.customer_id = c.customer_id
        """,
        "spark",
    )

    assert errors == []
    graph = build_column_graph(statements)
    assert {"id": "raw.orders.order_id->mart.sales.order_id", "source": "raw.orders.order_id", "target": "mart.sales.order_id"} in graph["edges"]
    assert {"id": "raw.orders.customer_id->mart.sales.customer_id", "source": "raw.orders.customer_id", "target": "mart.sales.customer_id"} in graph["edges"]
    assert {"id": "raw.customers.region->mart.sales.region", "source": "raw.customers.region", "target": "mart.sales.region"} in graph["edges"]


def test_column_lineage_for_insert_column_list() -> None:
    statements, errors = parse_lineage(
        "INSERT INTO mart.sales (id, region) SELECT order_id, region FROM raw.orders",
        "spark",
    )

    assert errors == []
    graph = build_column_graph(statements)
    assert {"id": "raw.orders.order_id->mart.sales.id", "source": "raw.orders.order_id", "target": "mart.sales.id"} in graph["edges"]
    assert {"id": "raw.orders.region->mart.sales.region", "source": "raw.orders.region", "target": "mart.sales.region"} in graph["edges"]


def test_column_lineage_for_star() -> None:
    statements, errors = parse_lineage("INSERT INTO mart.sales SELECT * FROM raw.orders", "spark")

    assert errors == []
    graph = build_column_graph(statements)
    assert {"id": "raw.orders.*->mart.sales.*", "source": "raw.orders.*", "target": "mart.sales.*"} in graph["edges"]


def test_column_lineage_preserves_cte_hops() -> None:
    statements, errors = parse_lineage(
        """
        WITH dms_mop_base AS (
            SELECT MRP, SALE_QTY, (MRP * SALE_QTY) AS MRP_AMOUNT
            FROM SALES_DATAMART.SILVER.FACT_TERTIARY_SALES_INVOICE FTS
        )
        SELECT dms.MRP_AMOUNT
        FROM dms_mop_base dms
        WHERE MRP_AMOUNT IS NOT NULL
        """,
        "snowflake",
    )

    assert errors == []
    amount = statements[0].columns[0]
    assert {"source": "dms_mop_base.MRP_AMOUNT", "target": "query_result_1.MRP_AMOUNT"} in amount["edges"]
    assert {
        "source": "SALES_DATAMART.SILVER.FACT_TERTIARY_SALES_INVOICE.MRP",
        "target": "dms_mop_base.MRP_AMOUNT",
    } in amount["edges"]
    assert {
        "source": "SALES_DATAMART.SILVER.FACT_TERTIARY_SALES_INVOICE.SALE_QTY",
        "target": "dms_mop_base.MRP_AMOUNT",
    } in amount["edges"]


def test_postgres_queries() -> None:
    statements, errors = parse_lineage(
        "SELECT * FROM a UNION SELECT * FROM b",
        "postgres",
    )
    assert errors == []
    assert len(statements) == 1
    assert statements[0].sources == ["a", "b"]

    statements, errors = parse_lineage(
        "UPDATE target SET a = source.c FROM source WHERE target.id = source.id",
        "postgres",
    )
    assert errors == []


def test_parse_stored_procedure() -> None:
    procedure_sql = """
    CREATE OR REPLACE PROCEDURE public.sp_product_mart()
     LANGUAGE plpgsql
    AS $procedure$
    BEGIN
        INSERT INTO public.product_mart (product_id)
        SELECT pp.id FROM source_odoo.product_product pp;
    END;
    $procedure$;
    """
    statements, errors = parse_lineage(procedure_sql, "postgres")
    assert errors == []
    assert len(statements) == 1
    assert statements[0].targets == ["public.product_mart"]
    assert statements[0].sources == ["source_odoo.product_product"]



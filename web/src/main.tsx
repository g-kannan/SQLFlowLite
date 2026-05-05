import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import {
  Braces,
  Clipboard,
  Columns3,
  Download,
  FileUp,
  Loader2,
  Play,
  Rows3,
  Table2,
  UploadCloud,
} from 'lucide-react';
import './styles.css';

type LineageNode = {
  id: string;
  label: string;
  kind: 'source' | 'target' | 'intermediate' | 'result';
};

type LineageEdge = {
  id: string;
  source: string;
  target: string;
};

type ParseResponse = {
  level: LineageLevel;
  nodes: LineageNode[];
  edges: LineageEdge[];
  statements: Array<{
    index: number;
    sql: string;
    targets: string[];
    sources: string[];
    columns: Array<{
      target: string;
      sources: string[];
      edges?: LineageEdge[];
      expression: string;
    }>;
    filename?: string;
  }>;
  errors: Array<string | { filename: string; message: string }>;
};

type LineageLevel = 'column' | 'table';
type ExportKind = 'list' | 'mermaid' | 'json';

const exampleSql = `CREATE TABLE mart.sales AS
SELECT o.order_id, o.customer_id, c.region
FROM raw.orders o
JOIN raw.customers c ON o.customer_id = c.customer_id;

INSERT INTO reporting.sales_by_region
SELECT region, count(*) AS orders
FROM mart.sales
GROUP BY region;`;

const nodeWidth = 280;
const nodeHeight = 68;
const mappingGroupWidth = 360;
const mappingColumnWidth = 316;
const mappingColumnHeight = 28;
const mappingHeaderHeight = 84;
const lineageMarker = { type: MarkerType.ArrowClosed, color: '#4b5563' };
const mappingMarker = { type: MarkerType.ArrowClosed, color: '#8aaeca' };

function layoutGraph(lineageNodes: LineageNode[], lineageEdges: LineageEdge[]): { nodes: Node[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 90 });

  lineageNodes.forEach((node) => {
    graph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  lineageEdges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);

  return {
    nodes: lineageNodes.map((node) => {
      const position = graph.node(node.id);
      return {
        id: node.id,
        data: { label: node.label },
        position: {
          x: position.x - nodeWidth / 2,
          y: position.y - nodeHeight / 2,
        },
        type: 'default',
        className: `lineage-node lineage-node--${node.kind}`,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
    }),
    edges: lineageEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: true,
      className: 'lineage-edge',
      markerEnd: lineageMarker,
    })),
  };
}

function displayGraph(response: ParseResponse, level: LineageLevel, expandColumns: boolean) {
  if (level === 'table') {
    return tableGraph(response);
  }
  return expandColumns ? expandedColumnGraph(response) : groupedColumnGraph(response);
}

function layoutDisplayGraph(response: ParseResponse, level: LineageLevel, expandColumns: boolean) {
  if (level === 'column' && expandColumns) {
    return mappingColumnGraph(response);
  }

  const rendered = displayGraph(response, level, expandColumns);
  return layoutGraph(rendered.nodes, rendered.edges);
}

function tableGraph(response: ParseResponse): { nodes: LineageNode[]; edges: LineageEdge[] } {
  const nodeKinds = new Map<string, LineageNode['kind']>();
  const edges = new Map<string, LineageEdge>();

  response.statements.forEach((statement) => {
    statement.sources.forEach((source) => {
      nodeKinds.set(source, mergeKind(nodeKinds.get(source), 'source'));
    });
    statement.targets.forEach((target) => {
      const kind = target.startsWith('query_result_') ? 'result' : 'target';
      nodeKinds.set(target, mergeKind(nodeKinds.get(target), kind));
    });
    statement.sources.forEach((source) => {
      statement.targets.forEach((target) => {
        if (source !== target) {
          edges.set(`${source}->${target}`, { id: `${source}->${target}`, source, target });
        }
      });
    });
  });

  return {
    nodes: Array.from(nodeKinds, ([id, kind]) => ({ id, label: tableLabel(id), kind })).sort(byId),
    edges: Array.from(edges.values()).sort(byId),
  };
}

function expandedColumnGraph(response: ParseResponse): { nodes: LineageNode[]; edges: LineageEdge[] } {
  const nodeKinds = new Map<string, LineageNode['kind']>();
  const edges = new Map<string, LineageEdge>();
  const finalTargets = new Set<string>();
  const edgeTargets = new Set<string>();

  response.statements.forEach((statement) => {
    statement.columns.forEach((column) => {
      const targetKind = column.target.startsWith('query_result_') ? 'result' : 'target';
      finalTargets.add(column.target);
      nodeKinds.set(column.target, mergeKind(nodeKinds.get(column.target), targetKind));
      const columnEdges = column.edges?.length
        ? column.edges
        : column.sources.map((source) => ({ id: `${source}->${column.target}`, source, target: column.target }));

      columnEdges.forEach((edge) => {
        if (edge.source !== edge.target) {
          edgeTargets.add(edge.target);
          edges.set(`${edge.source}->${edge.target}`, {
            id: `${edge.source}->${edge.target}`,
            source: edge.source,
            target: edge.target,
          });
        }
      });
    });
  });

  edges.forEach((edge) => {
    if (!nodeKinds.has(edge.source)) {
      nodeKinds.set(edge.source, edgeTargets.has(edge.source) ? 'intermediate' : 'source');
    }
    if (!nodeKinds.has(edge.target)) {
      nodeKinds.set(edge.target, finalTargets.has(edge.target) ? 'target' : 'intermediate');
    }
  });

  return {
    nodes: Array.from(nodeKinds, ([id, kind]) => ({ id, label: columnLabel(id), kind })).sort(byId),
    edges: Array.from(edges.values()).sort(byId),
  };
}

function groupedColumnGraph(response: ParseResponse): { nodes: LineageNode[]; edges: LineageEdge[] } {
  const nodeKinds = new Map<string, LineageNode['kind']>();
  const columnCounts = new Map<string, Set<string>>();
  const edges = new Map<string, LineageEdge>();
  const finalGroups = new Set<string>();
  const edgeTargetGroups = new Set<string>();

  response.statements.forEach((statement) => {
    statement.columns.forEach((column) => {
      const targetGroup = columnGroupId(column.target);
      const targetKind = targetGroup.startsWith('query_result_') ? 'result' : 'target';
      finalGroups.add(targetGroup);
      nodeKinds.set(targetGroup, mergeKind(nodeKinds.get(targetGroup), targetKind));
      addColumnCount(columnCounts, targetGroup, column.target);

      const columnEdges = column.edges?.length
        ? column.edges
        : column.sources.map((source) => ({ id: `${source}->${column.target}`, source, target: column.target }));

      columnEdges.forEach((edge) => {
        const sourceGroup = columnGroupId(edge.source);
        const edgeTargetGroup = columnGroupId(edge.target);
        edgeTargetGroups.add(edgeTargetGroup);
        nodeKinds.set(sourceGroup, mergeKind(nodeKinds.get(sourceGroup), 'source'));
        addColumnCount(columnCounts, sourceGroup, edge.source);
        addColumnCount(columnCounts, edgeTargetGroup, edge.target);
        if (sourceGroup !== edgeTargetGroup) {
          edges.set(`${sourceGroup}->${edgeTargetGroup}`, {
            id: `${sourceGroup}->${edgeTargetGroup}`,
            source: sourceGroup,
            target: edgeTargetGroup,
          });
        }
      });
    });
  });

  edges.forEach((edge) => {
    if (!nodeKinds.has(edge.source)) {
      nodeKinds.set(edge.source, edgeTargetGroups.has(edge.source) ? 'intermediate' : 'source');
    }
    if (!nodeKinds.has(edge.target)) {
      nodeKinds.set(edge.target, finalGroups.has(edge.target) ? 'target' : 'intermediate');
    }
  });

  return {
    nodes: Array.from(nodeKinds, ([id, kind]) => ({
      id,
      label: `${tableLabel(id)}\n${columnCounts.get(id)?.size ?? 0} columns`,
      kind,
    })).sort(byId),
    edges: Array.from(edges.values()).sort(byId),
  };
}

function mappingColumnGraph(response: ParseResponse): { nodes: Node[]; edges: Edge[] } {
  const expanded = expandedColumnGraph(response);
  const groupColumns = new Map<string, Set<string>>();
  const groupKinds = new Map<string, LineageNode['kind']>();
  const groupEdges = new Map<string, LineageEdge>();

  expanded.nodes.forEach((node) => {
    const group = columnGroupId(node.id);
    addColumnCount(groupColumns, group, node.id);
    groupKinds.set(group, mergeKind(groupKinds.get(group), node.kind));
  });

  expanded.edges.forEach((edge) => {
    const sourceGroup = columnGroupId(edge.source);
    const targetGroup = columnGroupId(edge.target);
    if (sourceGroup !== targetGroup) {
      groupEdges.set(`${sourceGroup}->${targetGroup}`, {
        id: `${sourceGroup}->${targetGroup}`,
        source: sourceGroup,
        target: targetGroup,
      });
    }
  });

  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: 70, ranksep: 110 });

  Array.from(groupColumns.keys()).forEach((group) => {
    graph.setNode(group, {
      width: mappingGroupWidth,
      height: mappingGroupHeight(groupColumns.get(group)?.size ?? 0),
    });
  });
  Array.from(groupEdges.values()).forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);

  const nodes: Node[] = [];
  Array.from(groupColumns.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([group, columns]) => {
      const position = graph.node(group);
      const sortedColumns = Array.from(columns).sort();
      const groupId = `group:${group}`;
      const height = mappingGroupHeight(sortedColumns.length);
      nodes.push({
        id: groupId,
        data: { label: `${groupTitle(groupKinds.get(group) ?? 'source')}: ${tableLabel(group)}` },
        position: {
          x: position.x - mappingGroupWidth / 2,
          y: position.y - height / 2,
        },
        className: `mapping-group mapping-group--${groupKinds.get(group) ?? 'source'}`,
        draggable: true,
        selectable: false,
        style: {
          width: mappingGroupWidth,
          height,
        },
      });

      sortedColumns.forEach((column, index) => {
        nodes.push({
          id: column,
          parentId: groupId,
          data: { label: columnShortName(column) },
          position: {
            x: 22,
            y: mappingHeaderHeight + index * 36,
          },
          extent: 'parent',
          className: `mapping-column mapping-column--${groupKinds.get(group) ?? 'source'}`,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          style: {
            width: mappingColumnWidth,
            height: mappingColumnHeight,
          },
        });
      });
    });

  return {
    nodes,
    edges: expanded.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: false,
      className: 'mapping-edge',
      markerEnd: mappingMarker,
    })),
  };
}

function applyColumnSelection(nodes: Node[], edges: Edge[], selectedColumn: string | null) {
  if (!selectedColumn) {
    return { nodes, edges };
  }

  return {
    nodes: nodes.map((node) => ({
      ...node,
      className:
        node.id === selectedColumn && typeof node.className === 'string' && node.className.includes('mapping-column')
          ? `${node.className} mapping-column--selected`
          : node.className,
    })),
    edges: edges.map((edge) => {
      if (edge.className !== 'mapping-edge') {
        return edge;
      }

      const isConnected = edge.source === selectedColumn || edge.target === selectedColumn;
      return {
        ...edge,
        animated: isConnected,
        className: isConnected ? 'mapping-edge mapping-edge--active' : 'mapping-edge',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isConnected ? '#f59e0b' : '#8aaeca',
        },
      };
    }),
  };
}

function mappingGroupHeight(columnCount: number) {
  return Math.max(132, mappingHeaderHeight + 20 + columnCount * 36);
}

function columnShortName(columnId: string) {
  const group = columnGroupId(columnId);
  const prefix = `${group}.`;
  return columnId.startsWith(prefix) ? columnId.slice(prefix.length) : columnId;
}

function groupTitle(kind: LineageNode['kind']) {
  if (kind === 'result') {
    return 'Query';
  }
  if (kind === 'intermediate') {
    return 'SubQuery';
  }
  return 'Table';
}

function mergeKind(current: LineageNode['kind'] | undefined, next: LineageNode['kind']) {
  if (!current || current === next) {
    return next;
  }
  if (current === 'result' || next === 'result') {
    return 'result';
  }
  if (current === 'target' || next === 'target') {
    return 'intermediate';
  }
  return current;
}

function addColumnCount(counts: Map<string, Set<string>>, group: string, column: string) {
  const set = counts.get(group) ?? new Set<string>();
  set.add(column);
  counts.set(group, set);
}

function columnGroupId(columnId: string) {
  const lastDot = columnId.lastIndexOf('.');
  return lastDot === -1 ? columnId : columnId.slice(0, lastDot);
}

function tableLabel(id: string) {
  if (!id.startsWith('query_result_')) {
    return id;
  }
  const suffix = id.replace('query_result_', '');
  return suffix === '1' ? 'Query Result' : `Query Result ${suffix}`;
}

function columnLabel(id: string) {
  if (!id.startsWith('query_result_')) {
    return id;
  }
  return id.replace('query_result_1.', 'Query Result.');
}

function byId<T extends { id: string }>(left: T, right: T) {
  return left.id.localeCompare(right.id);
}

function exportGraph(response: ParseResponse, level: LineageLevel, expandColumns: boolean) {
  if (level === 'table') {
    return tableGraph(response);
  }
  return expandColumns ? expandedColumnGraph(response) : groupedColumnGraph(response);
}

function listExport(response: ParseResponse, level: LineageLevel) {
  const graph = level === 'table' ? tableGraph(response) : expandedColumnGraph(response);
  return graph.nodes.map((node) => node.id).sort().join('\n');
}

function mermaidExport(graph: { nodes: LineageNode[]; edges: LineageEdge[] }) {
  const ids = new Map(graph.nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ['flowchart LR'];

  graph.nodes.forEach((node) => {
    lines.push(`  ${ids.get(node.id)}["${escapeMermaidLabel(node.label)}"]`);
  });
  graph.edges.forEach((edge) => {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (source && target) {
      lines.push(`  ${source} --> ${target}`);
    }
  });
  return lines.join('\n');
}

function jsonExport(
  response: ParseResponse,
  graph: { nodes: LineageNode[]; edges: LineageEdge[] },
  level: LineageLevel,
  expandColumns: boolean,
) {
  return JSON.stringify(
    {
      level,
      view: level === 'column' && expandColumns ? 'expanded-columns' : level === 'column' ? 'grouped-columns' : 'tables',
      nodes: graph.nodes,
      edges: graph.edges,
      statements: response.statements,
      errors: response.errors,
    },
    null,
    2,
  );
}

function escapeMermaidLabel(label: string) {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '<br/>');
}

function exportFilename(kind: ExportKind, level: LineageLevel) {
  const extension = kind === 'json' ? 'json' : kind === 'mermaid' ? 'mmd' : 'txt';
  return `sqlflowlite-${level}-${kind}.${extension}`;
}

function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [sql, setSql] = useState(exampleSql);
  const [dialect, setDialect] = useState('spark');
  const [level, setLevel] = useState<LineageLevel>('column');
  const [expandColumns, setExpandColumns] = useState(false);
  const [exportKind, setExportKind] = useState<ExportKind>('list');
  const [result, setResult] = useState<ParseResponse | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null);

  const parseSql = useCallback(async () => {
    setLoading(true);
    setStatus('Parsing SQL');
    try {
      const response = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, dialect, level }),
      });
      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }
      const data = (await response.json()) as ParseResponse;
      setResult(data);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Parsing failed');
    } finally {
      setLoading(false);
    }
  }, [dialect, level, sql]);

  const uploadFiles = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      if (selected.length === 0) {
        return;
      }

      setLoading(true);
      setStatus('Reading files');
      try {
        const files = await Promise.all(
          selected.map(async (file) => ({
            filename: file.name,
            sql: await file.text(),
          })),
        );
        const response = await fetch('/api/parse-multi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files, dialect, level }),
        });
        if (!response.ok) {
          throw new Error(`API returned ${response.status}`);
        }
        const data = (await response.json()) as ParseResponse;
        setResult(data);
        setSql(files.map((file) => `-- ${file.filename}\n${file.sql}`).join('\n\n'));
        setStatus(`${selected.length} files parsed`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Upload failed');
      } finally {
        event.target.value = '';
        setLoading(false);
      }
    },
    [dialect, level],
  );

  useEffect(() => {
    if (!result) {
      return;
    }

    const baseGraph = layoutDisplayGraph(result, level, expandColumns);
    const graph = applyColumnSelection(baseGraph.nodes, baseGraph.edges, selectedColumn);
    setNodes(graph.nodes);
    setEdges(graph.edges);
    const unit = level === 'column' && !expandColumns ? 'groups' : level === 'column' ? 'mapped columns' : 'tables';
    setStatus(`${graph.nodes.length} ${unit}, ${graph.edges.length} dependencies`);
  }, [expandColumns, level, result, selectedColumn, setEdges, setNodes]);

  const selectColumn = useCallback((_: React.MouseEvent, node: Node) => {
    if (typeof node.className !== 'string' || !node.className.includes('mapping-column')) {
      setSelectedColumn(null);
      return;
    }
    setSelectedColumn((current) => (current === node.id ? null : node.id));
  }, []);

  const errorMessages = useMemo(() => {
    if (!result?.errors.length) {
      return [];
    }
    return result.errors.map((error) =>
      typeof error === 'string' ? error : `${error.filename}: ${error.message}`,
    );
  }, [result]);

  const exportText = useMemo(() => {
    if (!result) {
      return '';
    }

    const graph = exportGraph(result, level, expandColumns);
    if (exportKind === 'list') {
      return listExport(result, level);
    }
    if (exportKind === 'mermaid') {
      return mermaidExport(graph);
    }
    return jsonExport(result, graph, level, expandColumns);
  }, [expandColumns, exportKind, level, result]);

  const copyExport = useCallback(async () => {
    if (!exportText) {
      return;
    }
    await navigator.clipboard.writeText(exportText);
    setStatus(`${exportKind} copied`);
  }, [exportKind, exportText]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div>
            <h1>SQLFlowLite</h1>
            <p>Column and table lineage from SQL text only</p>
          </div>
        </div>

        <label className="field-label" htmlFor="dialect">
          Dialect
        </label>
        <select id="dialect" value={dialect} onChange={(event) => setDialect(event.target.value)}>
          <option value="spark">Spark</option>
          <option value="postgres">Postgres</option>
          <option value="snowflake">Snowflake</option>
          <option value="bigquery">BigQuery</option>
          <option value="redshift">Redshift</option>
          <option value="mysql">MySQL</option>
          <option value="tsql">T-SQL</option>
        </select>

        <label className="field-label" htmlFor="sql-input">
          SQL
        </label>
        <textarea
          id="sql-input"
          spellCheck={false}
          value={sql}
          onChange={(event) => setSql(event.target.value)}
        />

        <div className="actions">
          <button onClick={parseSql} disabled={loading || sql.trim().length === 0}>
            {loading ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            Parse
          </button>
          <label className="upload-button">
            <FileUp size={18} />
            Upload
            <input type="file" accept=".sql,text/sql,text/plain" multiple onChange={uploadFiles} />
          </label>
        </div>

        <div className="status-line">
          <UploadCloud size={16} />
          <span>{status}</span>
        </div>

        {errorMessages.length > 0 && (
          <div className="errors">
            {errorMessages.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        )}

        <button
          className="raw-toggle"
          type="button"
          onClick={() => setShowRawJson((current) => !current)}
          disabled={!result}
        >
          <Braces size={18} />
          {showRawJson ? 'Hide JSON' : 'Show JSON'}
        </button>

        {showRawJson && result && (
          <pre className="raw-json">{JSON.stringify(result, null, 2)}</pre>
        )}
      </aside>

      <main className="diagram">
        <div className="diagram-toolbar">
          <div className="diagram-title">
            <h2>{level === 'column' ? 'Column Lineage' : 'Table Lineage'}</h2>
            <p>{level === 'column' && !expandColumns ? 'Grouped by table or query result' : 'Expanded dependency graph'}</p>
          </div>
          <div className="diagram-controls">
            <div className="segmented" role="group" aria-label="Lineage level">
              <button
                className={level === 'column' ? 'active' : ''}
                type="button"
                onClick={() => setLevel('column')}
              >
                <Columns3 size={17} />
                Column
              </button>
              <button
                className={level === 'table' ? 'active' : ''}
                type="button"
                onClick={() => setLevel('table')}
              >
                <Table2 size={17} />
                Table
              </button>
            </div>
            {level === 'column' && (
              <button
                className="expand-toggle"
                type="button"
                onClick={() => setExpandColumns((current) => !current)}
              >
                <Rows3 size={17} />
                {expandColumns ? 'Group' : 'Expand'}
              </button>
            )}
          </div>
        </div>
        <section className="export-panel" aria-label="Lineage export">
          <div className="export-header">
            <div className="export-tabs" role="group" aria-label="Export format">
              <button
                className={exportKind === 'list' ? 'active' : ''}
                type="button"
                onClick={() => setExportKind('list')}
              >
                List
              </button>
              <button
                className={exportKind === 'mermaid' ? 'active' : ''}
                type="button"
                onClick={() => setExportKind('mermaid')}
              >
                Mermaid
              </button>
              <button
                className={exportKind === 'json' ? 'active' : ''}
                type="button"
                onClick={() => setExportKind('json')}
              >
                JSON
              </button>
            </div>
            <div className="export-actions">
              <button type="button" onClick={copyExport} disabled={!exportText}>
                <Clipboard size={16} />
                Copy
              </button>
              <button
                type="button"
                onClick={() => downloadText(exportFilename(exportKind, level), exportText)}
                disabled={!exportText}
              >
                <Download size={16} />
                Export
              </button>
            </div>
          </div>
          <textarea
            className="export-output"
            readOnly
            value={exportText || 'Parse SQL to generate export text.'}
            aria-label="Export output"
          />
        </section>
        <div className="flow-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={selectColumn}
            onPaneClick={() => setSelectedColumn(null)}
            fitView
            fitViewOptions={{ padding: 0.25 }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

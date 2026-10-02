// Connects to an MCP endpoint over HTTP and runs two read calls.
// Usage: node scripts/probe-mcp.mjs https://ops.frankonline.cloud/mcp
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const url = process.argv[2];
const client = new Client({ name: 'probe', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
const r = await client.callTool({ name: 'list_unpaid_invoices', arguments: { min_days_overdue: 14 } });
const d = JSON.parse(r.content[0].text);
console.log('overdue 14+ days:', d.count, d.total_outstanding, d.invoices[0]);
const w = await client.callTool({ name: 'issue_refund', arguments: { invoice_id: 1, amount: 1, reason: 'test' } }).catch((e) => ({ err: e.message }));
console.log('write attempt:', JSON.stringify(w).slice(0, 160));
await client.close();

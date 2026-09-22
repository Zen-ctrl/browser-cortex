import { useEffect, useMemo, useState } from 'react';

type TicketStatus = 'Needs review' | 'Approved' | 'On hold';
type RecordField = readonly [key: string, label: string, displayValue: string, rawValue: string];

const INTEGRATION_ID = 'northline-demo-v1';
const INTEGRATION_VERSION = '1.0.0';
const purchaseOrder = {
  reference: 'PO-DEMO-1001',
  supplier: 'Atlas Synthetic Supply',
  quantity: 120,
  unitPriceMinor: 350,
  currency: 'USD',
  requestedDelivery: '2026-10-14',
};
const invoice = {
  reference: 'PO-DEMO-1001',
  invoice: 'INV-DEMO-2048',
  supplier: 'Atlas Synthetic Supply',
  quantity: 125,
  unitPriceMinor: 350,
  currency: 'USD',
  requestedDelivery: '2026-10-14',
};

const tools = [
  {
    schemaVersion: 1,
    name: 'demo.records.read',
    version: INTEGRATION_VERSION,
    effect: 'read',
    implementationId: 'northline-demo-record-reader',
    requiredCapabilities: ['active-demo:read'],
  },
  {
    schemaVersion: 1,
    name: 'demo.ticket.status.set',
    version: INTEGRATION_VERSION,
    effect: 'local-write',
    implementationId: 'northline-demo-ticket-status',
    requiredCapabilities: ['active-demo:write'],
    reversible: true,
  },
] as const;

function emit(operation: string, detail: Record<string, string | number | boolean>) {
  window.dispatchEvent(new CustomEvent('browser-cortex:demo-action', {
    detail: { operation, integrationVersion: INTEGRATION_VERSION, ...detail },
  }));
}

export function DemoApp() {
  const [ticketStatus, setTicketStatus] = useState<TicketStatus>('Needs review');
  const [previousStatus, setPreviousStatus] = useState<TicketStatus>();
  const [notice, setNotice] = useState('');
  const comparison = useMemo(() => ({
    quantityDifference: invoice.quantity - purchaseOrder.quantity,
    monetaryDifferenceMinor: (invoice.quantity - purchaseOrder.quantity) * purchaseOrder.unitPriceMinor,
    currencyMismatch: invoice.currency !== purchaseOrder.currency,
  }), []);

  useEffect(() => {
    // This declaration is intentionally untrusted. The extension compares the visible
    // declaration fields to its own packaged integration contract before any use.
    window.postMessage({
      source: 'browser-cortex-demo',
      schemaVersion: 1,
      type: 'tool-descriptors',
      payload: tools,
    }, location.origin);
  }, []);

  function updateStatus(next: TicketStatus) {
    if (next === ticketStatus) return;
    const before = ticketStatus;
    setPreviousStatus(before);
    setTicketStatus(next);
    setNotice(`Synthetic ticket moved from ${before} to ${next}.`);
    emit('demo.ticket.status.set', {
      recordId: purchaseOrder.reference,
      field: 'status',
      from: before,
      to: next,
    });
  }

  function undo() {
    if (!previousStatus) return;
    const before = ticketStatus;
    setTicketStatus(previousStatus);
    setPreviousStatus(undefined);
    setNotice(`Undo restored ${previousStatus}.`);
    emit('demo.ticket.status.set', {
      recordId: purchaseOrder.reference,
      field: 'status',
      from: before,
      to: previousStatus,
    });
  }

  const purchaseOrderFields: RecordField[] = [
    ['reference', 'Reference', purchaseOrder.reference, purchaseOrder.reference],
    ['supplier', 'Supplier', purchaseOrder.supplier, purchaseOrder.supplier],
    ['quantity', 'Quantity', String(purchaseOrder.quantity), String(purchaseOrder.quantity)],
    ['unitPriceMinor', 'Unit price', formatMoney(purchaseOrder.unitPriceMinor, purchaseOrder.currency), String(purchaseOrder.unitPriceMinor)],
    ['currency', 'Currency', purchaseOrder.currency, purchaseOrder.currency],
    ['requestedDelivery', 'Requested delivery', purchaseOrder.requestedDelivery, purchaseOrder.requestedDelivery],
  ];
  const invoiceFields: RecordField[] = [
    ['invoice', 'Invoice', invoice.invoice, invoice.invoice],
    ['reference', 'PO reference', invoice.reference, invoice.reference],
    ['supplier', 'Supplier', invoice.supplier, invoice.supplier],
    ['quantity', 'Quantity', String(invoice.quantity), String(invoice.quantity)],
    ['unitPriceMinor', 'Unit price', formatMoney(invoice.unitPriceMinor, invoice.currency), String(invoice.unitPriceMinor)],
    ['currency', 'Currency', invoice.currency, invoice.currency],
    ['requestedDelivery', 'Requested delivery', invoice.requestedDelivery, invoice.requestedDelivery],
  ];

  return (
    <div
      className="demo-shell"
      data-bc-demo-integration={INTEGRATION_ID}
      data-bc-demo-version={INTEGRATION_VERSION}
    >
      <header className="demo-topbar">
        <a className="demo-brand" href="#top"><span>N</span><div><strong>Northline</strong><small>operations desk</small></div></a>
        <nav aria-label="Demo navigation"><a href="#review">Review queue</a><a href="#records">Records</a><a href="#activity">Activity</a></nav>
        <div className="demo-user"><span>SD</span><div><strong>Synthetic demo</strong><small>No real account</small></div></div>
      </header>
      <main id="top">
        <section className="demo-hero">
          <div><p className="demo-eyebrow">Review queue / {purchaseOrder.reference}</p><h1>Invoice reconciliation</h1><p>Compare a purchase order with its matching invoice before a reversible synthetic status change.</p></div>
          <div className="demo-status" data-bc-demo-current-status={ticketStatus}><span className={ticketStatus === 'Approved' ? 'is-approved' : ticketStatus === 'On hold' ? 'is-hold' : ''} />{ticketStatus}</div>
        </section>
        <div className="demo-banner"><strong>Safe demonstration environment</strong><span>Every record on this page is deterministic synthetic data. No action leaves this browser.</span></div>
        <section className="review-grid" id="review">
          <DocumentCard accent="green" fields={purchaseOrderFields} kind="Purchase order" recordType="purchase-order" />
          <div className="comparison-rail"><span>Compared by ordinary code</span><i /><strong>{comparison.quantityDifference > 0 ? '+' : ''}{comparison.quantityDifference}</strong><small>quantity difference</small><i /><b>{formatMoney(comparison.monetaryDifferenceMinor, purchaseOrder.currency)}</b><small>monetary difference</small></div>
          <DocumentCard accent="gold" fields={invoiceFields} kind="Invoice" recordType="invoice" />
        </section>
        <section className="finding-card"><div className="finding-icon">!</div><div><p className="demo-eyebrow">Deterministic finding</p><h2>Invoice quantity exceeds the purchase order by 5 units.</h2><p>At USD 3.50 per unit, the difference is USD 17.50. No model performed this arithmetic.</p></div><span>Needs review</span></section>
        <section className="action-card" id="records">
          <div><p className="demo-eyebrow">Reversible synthetic action</p><h2>Update ticket status</h2><p>The BrowserCortex recorder can capture this semantic event on the demo site. It does not record raw clicks or form inputs.</p></div>
          <div className="status-buttons">
            {(['Needs review', 'Approved', 'On hold'] as TicketStatus[]).map((status) => (
              <button
                aria-pressed={ticketStatus === status}
                data-bc-demo-status-target={status}
                key={status}
                onClick={() => updateStatus(status)}
                type="button"
              >{status}</button>
            ))}
          </div>
          {notice && <div className="action-notice" role="status"><span>{notice}</span>{previousStatus && <button onClick={undo} type="button">Undo</button>}</div>}
        </section>
        <section className="tool-card">
          <div><p className="demo-eyebrow">Vetted integration surface</p><h2>Page tool declarations remain untrusted</h2></div>
          <div className="tool-list">
            {tools.map((tool) => (
              <article
                data-bc-demo-tool-effect={tool.effect}
                data-bc-demo-tool-implementation={tool.implementationId}
                data-bc-demo-tool-name={tool.name}
                data-bc-demo-tool-version={tool.version}
                key={tool.name}
              >
                <code>{tool.name}</code><span>{tool.effect}</span><small>{tool.implementationId}</small>
              </article>
            ))}
          </div>
          <p>Extension policy must match these declarations to a packaged implementation before use. This page cannot grant its own permission.</p>
        </section>
        <section className="sensitive-fixture" data-browser-cortex-private id="activity"><h2>Capture exclusion fixture</h2><p>This form verifies that visible-content capture excludes password and editable fields.</p><label>Demo username<input autoComplete="off" defaultValue="synthetic.operator" /></label><label>Demo password<input autoComplete="new-password" defaultValue="NEVER_CAPTURE_THIS_VALUE" type="password" /></label></section>
      </main>
      <footer><span>Northline is a fictional company used only for BrowserCortex tests.</span><span>Integration v{INTEGRATION_VERSION}</span></footer>
    </div>
  );
}

function DocumentCard({ kind, fields, accent, recordType }: {
  kind: string;
  fields: readonly RecordField[];
  accent: 'green' | 'gold';
  recordType: 'purchase-order' | 'invoice';
}) {
  return (
    <article className={`document-card document-card--${accent}`} data-bc-demo-record={recordType}>
      <header><span>{kind.slice(0, 2).toUpperCase()}</span><div><p className="demo-eyebrow">Source record</p><h2>{kind}</h2></div><b>Verified fixture</b></header>
      <dl>{fields.map(([key, label, displayValue, rawValue]) => <div key={key}><dt>{label}</dt><dd data-bc-demo-field={key} data-bc-demo-value={rawValue}>{displayValue}</dd></div>)}</dl>
      <div className="document-footer"><span>Text record</span><span>Revision 1</span></div>
    </article>
  );
}

function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

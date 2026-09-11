export type OrderSource = 'voice' | 'manual' | 'demo'

export interface OrderDraftItem {
  menu_id: string
  quantity: number
  note?: string
}

export interface SubmittedOrderItem extends OrderDraftItem {
  name: string
  unit_price_usd: number
  line_total_usd: number
}

export interface SubmittedOrder {
  ticket_id: string
  table: number
  source: OrderSource
  status: 'received' | 'demo'
  eta_minutes: number
  item_count: number
  subtotal_usd: number
  tax_usd: number
  total_usd: number
  created_at: string
  items: SubmittedOrderItem[]
}

interface SubmitOrderResponse {
  ok?: boolean
  order?: SubmittedOrder
  error?: string
}

/** Submit a ticket to the restaurant backend without exposing any credentials. */
export async function submitLiveOrder(
  items: OrderDraftItem[],
  options: { table: number; source: Exclude<OrderSource, 'demo'> },
): Promise<SubmittedOrder> {
  let response: Response
  try {
    response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table: options.table,
        source: options.source,
        items,
      }),
    })
  } catch {
    throw new Error('could not reach the kitchen service')
  }

  let payload: SubmitOrderResponse = {}
  try {
    payload = (await response.json()) as SubmitOrderResponse
  } catch {
    // Keep the user-facing error useful if a proxy returns a non-JSON response.
  }

  if (!response.ok || !payload.ok || !payload.order) {
    throw new Error(payload.error || 'the kitchen could not accept this order')
  }

  return payload.order
}

/** Keeps the static site useful when no backend is configured. */
export function makeDemoOrder(
  items: SubmittedOrderItem[],
  table: number,
  taxRate: number,
): SubmittedOrder {
  const subtotal = items.reduce((total, item) => total + item.line_total_usd, 0)
  const tax = +(subtotal * taxRate).toFixed(2)

  return {
    ticket_id: 'DEMO-1422',
    table,
    source: 'demo',
    status: 'demo',
    eta_minutes: 14,
    item_count: items.reduce((total, item) => total + item.quantity, 0),
    subtotal_usd: +subtotal.toFixed(2),
    tax_usd: tax,
    total_usd: +(subtotal + tax).toFixed(2),
    created_at: new Date().toISOString(),
    items,
  }
}

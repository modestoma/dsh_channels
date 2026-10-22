import { describe, expect, it, vi } from 'vitest'
import { CardDelivery } from '../src/feishu/delivery.ts'
import type { FeishuChannel, NormalizedMessage } from '../src/feishu-channel.ts'

describe('CardDelivery.replacingCard', () => {
  it('keeps replacing while any overlapping scope for the card is open', async () => {
    const channel = {
      send: vi.fn(async () => ({ messageId: 'om_new' })),
      updateCard: vi.fn(async () => {}),
    }
    const delivery = new CardDelivery({
      channel: () => channel as unknown as FeishuChannel,
      started: () => true,
      routeForSession: () => undefined,
      warn: () => {},
    })
    const msg = { messageId: 'om_picker', chatId: 'oc_1' } as NormalizedMessage
    let releaseFirst!: () => void
    const first = delivery.replacingCard('om_picker', () => new Promise<void>(resolve => { releaseFirst = resolve }))
    let releaseSecond!: () => void
    const second = delivery.replacingCard('om_picker', () => new Promise<void>(resolve => { releaseSecond = resolve }))
    releaseFirst()
    await first
    await delivery.standaloneReply(msg, { id: 'second' })
    expect(channel.updateCard).toHaveBeenCalledWith('om_picker', { id: 'second' })
    releaseSecond()
    await second
    await delivery.standaloneReply(msg, { id: 'after' })
    expect(channel.updateCard).toHaveBeenCalledTimes(1)
    expect(channel.send).toHaveBeenCalledTimes(1)
  })
})

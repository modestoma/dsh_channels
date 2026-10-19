/**
 * 「连接」tab：按 Host 派生的生命周期阶段渲染连接引导。
 *
 * - unconfigured：onboarding 三步 + 凭据卡（不渲染可用的「连接」按钮）
 * - idle：连接信息卡 + 「连接飞书」
 * - error：连接信息卡 + 最近一次连接失败 + 「重试」
 * - connected：连接信息卡 + 「重启飞书连接」+ 凭据卡
 * - connecting：禁用按钮显示「连接中…」
 *
 * @module dsh-channels/client/panel/connection-tab
 */

import { PANEL_COPY } from '../../settings/contract.ts'
import type { ChannelStatusWire, PanelWire } from '../../settings/contract.ts'
import { CredentialsCard } from './credentials-card.tsx'
import { connectionStateLabel, fieldLabel, formatUptime, phaseBadge, TabHelp } from './shared.tsx'
import type { BusyAction, CredentialsView } from './shared.tsx'

export interface ConnectionTabProps {
  panel: PanelWire
  status: ChannelStatusWire
  busy: BusyAction | null
  credentials: CredentialsView
  onReconnect: () => void
}

export function ConnectionTab(props: ConnectionTabProps): JSX.Element {
  const { panel, status, busy, credentials, onReconnect } = props
  return (
    <div className="dsh-channels-cfg__tabBody">
      <TabHelp text={PANEL_COPY.connectionTabHelp} />
      {panel.config.restartPendingKeys.length === 0
        ? null
        : <RestartBanner panel={panel} busy={busy} locked={status.busy} onReconnect={onReconnect} />}
      {status.phase === 'unconfigured'
        ? <OnboardingCard status={status} />
        : <ConnectionInfoCard status={status} busy={busy} onReconnect={onReconnect} />}
      <CredentialsCard panel={panel} credentials={credentials} />
    </div>
  )
}

/** First-run guide: create the app, fill the credentials, save and wait. */
function OnboardingCard(props: { status: ChannelStatusWire }): JSX.Element {
  const { status } = props
  const steps = [
    { title: PANEL_COPY.onboardingStep1Title, text: PANEL_COPY.onboardingStep1Text },
    { title: PANEL_COPY.onboardingStep2Title, text: PANEL_COPY.onboardingStep2Text },
    { title: PANEL_COPY.onboardingStep3Title, text: PANEL_COPY.onboardingStep3Text },
  ]
  return (
    <section className="dsh-channels-cfg__card">
      <div className="dsh-channels-cfg__cardHead">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.onboardingTitle}</span>
        <span className="dsh-channels-cfg__badge dsh-channels-cfg__badge--muted">
          {PANEL_COPY.phaseUnconfigured}
        </span>
      </div>
      <span className="dsh-channels-cfg__help">{PANEL_COPY.onboardingIntro}</span>
      <ol className="dsh-channels-cfg__steps">
        {steps.map((step, index) => (
          <li className="dsh-channels-cfg__step" key={step.title}>
            <span className="dsh-channels-cfg__stepIndex">{index + 1}</span>
            <span className="dsh-channels-cfg__stepBody">
              <span className="dsh-channels-cfg__stepTitle">{step.title}</span>
              <span className="dsh-channels-cfg__help">{step.text}</span>
            </span>
          </li>
        ))}
      </ol>
      {status.missingConfig.length === 0
        ? null
        : (
            <div className="dsh-channels-cfg__banner">
              <strong>{PANEL_COPY.missingConfig}：</strong>
              <span>{status.missingConfig.join('、')}</span>
            </div>
          )}
      <span className="dsh-channels-cfg__help">{PANEL_COPY.statusHintUnconfigured}</span>
      <span className="dsh-channels-cfg__help">{PANEL_COPY.onboardingDocsHint}</span>
    </section>
  )
}

/** Runtime facts plus the one lifecycle action available in the current phase. */
function ConnectionInfoCard(props: {
  status: ChannelStatusWire
  busy: BusyAction | null
  onReconnect: () => void
}): JSX.Element {
  const { status, busy, onReconnect } = props
  const badge = phaseBadge(status.phase)
  // `status.busy` covers a connection attempt started outside this panel; the
  // local busy flag covers the panel's own action. Either way the button waits.
  const actionBusy = busy !== null || status.busy
  const connection = connectionStateLabel(status.connection?.state)
  const facts = [
    { label: PANEL_COPY.statusCard, value: badge.text },
    { label: PANEL_COPY.connectionStateLabel, value: connection.text },
    { label: PANEL_COPY.botOpenId, value: status.botOpenIdTail ?? PANEL_COPY.unknownValue },
    { label: PANEL_COPY.uptime, value: formatUptime(status.uptimeMs) },
    { label: PANEL_COPY.routeCount, value: String(status.routeCount) },
    { label: PANEL_COPY.liveAgentCount, value: String(status.liveAgentCount) },
    { label: PANEL_COPY.inflightTurnCount, value: String(status.inflightTurnCount) },
  ]
  return (
    <section className="dsh-channels-cfg__card">
      <div className="dsh-channels-cfg__cardHead">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.connectionInfo}</span>
        <span className={`dsh-channels-cfg__badge dsh-channels-cfg__badge--${status.configured ? 'ok' : 'bad'}`}>
          {status.configured ? PANEL_COPY.configuredBadge : PANEL_COPY.unconfiguredBadge}
        </span>
      </div>
      {status.lastStartError === undefined
        ? null
        : (
            <div className="dsh-channels-cfg__notice dsh-channels-cfg__notice--error">
              <strong>{PANEL_COPY.lastError}</strong>
              <span className="dsh-channels-cfg__mono">{status.lastStartError}</span>
            </div>
          )}
      <div className="dsh-channels-cfg__facts">
        {facts.map(fact => (
          <div className="dsh-channels-cfg__fact" key={fact.label}>
            <span className="dsh-channels-cfg__factLabel">{fact.label}</span>
            <span className="dsh-channels-cfg__factValue">{fact.value}</span>
          </div>
        ))}
      </div>
      {status.reasons.length === 0
        ? null
        : (
            <span className={`dsh-channels-cfg__help${status.level === 'unhealthy' ? ' dsh-channels-cfg__reasonBad' : ''}`}>
              {PANEL_COPY.healthReasons}：{status.reasons.join('；')}
            </span>
          )}
      <div className="dsh-channels-cfg__actions">
        {status.phase === 'connecting'
          ? (
              <button type="button" className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary" disabled>
                {PANEL_COPY.connecting}
              </button>
            )
          : null}
        {status.phase === 'idle'
          ? (
              <button
                type="button"
                className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                onClick={onReconnect}
                disabled={actionBusy}
              >
                {busy === 'reconnect' ? PANEL_COPY.connecting : PANEL_COPY.connect}
              </button>
            )
          : null}
        {status.phase === 'error'
          ? (
              <button
                type="button"
                className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                onClick={onReconnect}
                disabled={actionBusy}
              >
                {busy === 'reconnect' ? PANEL_COPY.connecting : PANEL_COPY.retry}
              </button>
            )
          : null}
        {status.phase === 'connected'
          ? (
              <>
                <button
                  type="button"
                  className="dsh-channels-cfg__btn dsh-channels-cfg__btn--danger"
                  onClick={onReconnect}
                  disabled={actionBusy}
                >
                  {busy === 'reconnect' ? PANEL_COPY.reconnecting : PANEL_COPY.reconnect}
                </button>
                <span className="dsh-channels-cfg__help">{PANEL_COPY.restartWarning}</span>
              </>
            )
          : null}
      </div>
    </section>
  )
}

/** Config saved but only applied on the next connect: offer the one-click restart. */
function RestartBanner(props: {
  panel: PanelWire
  busy: BusyAction | null
  locked: boolean
  onReconnect: () => void
}): JSX.Element {
  const { panel, busy, locked, onReconnect } = props
  const keys = panel.config.restartPendingKeys
    .map(key => fieldLabel(panel.config.fields, key))
    .join('、')
  return (
    <div className="dsh-channels-cfg__banner">
      <span>{PANEL_COPY.restartBanner}{keys}</span>
      <button
        type="button"
        className="dsh-channels-cfg__btn dsh-channels-cfg__btn--danger"
        onClick={onReconnect}
        disabled={busy !== null || locked}
      >
        {busy === 'reconnect' ? PANEL_COPY.reconnecting : PANEL_COPY.reconnect}
      </button>
      <span className="dsh-channels-cfg__help">{PANEL_COPY.restartWarning}</span>
    </div>
  )
}

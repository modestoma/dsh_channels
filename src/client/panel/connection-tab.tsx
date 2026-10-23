/**
 * 「连接」tab：按 Host 派生的生命周期阶段渲染。
 *
 * - unconfigured：上手三步 + 应用凭据
 * - idle / error / connecting / connected：状态块（当前阶段的唯一操作 + 运行数字）
 * - 连接后：自检（权限缺口可展开、斜杠指令面板同步结果）
 * - 有需重连才生效的已保存配置：顶部「重启连接」横幅
 *
 * @module dsh-channels/client/panel/connection-tab
 */

import { useState } from 'react'
import { fillCopy, PANEL_COPY } from '../../settings/contract.ts'
import type { ChannelStatusWire, PanelWire, ScopeCheckWire, SlashCommandSyncWire } from '../../settings/contract.ts'
import { CredentialsSection } from './credentials-card.tsx'
import { fieldLabel, phaseBadge, phaseSummary, Pill, Row, Section } from './shared.tsx'
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
  const checks = status.scopeCheck !== undefined || status.slashCommandSync !== undefined
  return (
    <div className="dsh-channels-cfg__tabBody">
      {panel.config.restartPendingKeys.length === 0
        ? null
        : <RestartBanner panel={panel} busy={busy} locked={status.busy} onReconnect={onReconnect} />}
      {status.phase === 'unconfigured'
        ? <OnboardingSection status={status} />
        : <StatusBlock status={status} busy={busy} onReconnect={onReconnect} />}
      {checks
        ? (
            <Section title={PANEL_COPY.checksTitle}>
              {status.scopeCheck === undefined ? null : <ScopeCheckRow check={status.scopeCheck} />}
              {status.slashCommandSync === undefined ? null : <SlashCommandSyncRow sync={status.slashCommandSync} />}
            </Section>
          )
        : null}
      <CredentialsSection panel={panel} credentials={credentials} />
    </div>
  )
}

/** First-run guide: create the app, fill the credentials, save and wait. */
function OnboardingSection(props: { status: ChannelStatusWire }): JSX.Element {
  const { status } = props
  const steps = [
    { title: PANEL_COPY.onboardingStep1Title, text: PANEL_COPY.onboardingStep1Text },
    { title: PANEL_COPY.onboardingStep2Title, text: PANEL_COPY.onboardingStep2Text },
    { title: PANEL_COPY.onboardingStep3Title, text: PANEL_COPY.onboardingStep3Text },
  ]
  return (
    <div className="dsh-channels-cfg__hero">
      <div className="dsh-channels-cfg__heroTop">
        <strong>{PANEL_COPY.onboardingTitle}</strong>
      </div>
      <ol className="dsh-channels-cfg__steps">
        {steps.map((step, index) => (
          <li className="dsh-channels-cfg__step" key={step.title}>
            <span className="dsh-channels-cfg__stepIndex">{index + 1}</span>
            <span className="dsh-channels-cfg__stepBody">
              <span className="dsh-channels-cfg__stepTitle">{step.title}</span>
              <span className="dsh-channels-cfg__rowSummary">{step.text}</span>
            </span>
          </li>
        ))}
      </ol>
      {status.missingConfig.length === 0
        ? null
        : (
            <span className="dsh-channels-cfg__rowSummary">
              {PANEL_COPY.missingConfig}：{status.missingConfig.join('、')}
            </span>
          )}
    </div>
  )
}

/** Phase, the one lifecycle action available in it, and the runtime counters. */
function StatusBlock(props: {
  status: ChannelStatusWire
  busy: BusyAction | null
  onReconnect: () => void
}): JSX.Element {
  const { status, busy, onReconnect } = props
  const badge = phaseBadge(status.phase)
  // `status.busy` covers a connection attempt started outside this panel; the
  // local busy flag covers the panel's own action. Either way the button waits.
  const actionBusy = busy !== null || status.busy
  const stats = [
    { label: PANEL_COPY.routeCount, value: String(status.routeCount) },
    { label: PANEL_COPY.liveAgentCount, value: String(status.liveAgentCount) },
    { label: PANEL_COPY.inflightTurnCount, value: String(status.inflightTurnCount) },
    { label: PANEL_COPY.botOpenId, value: status.botOpenIdTail ?? PANEL_COPY.unknownValue, mono: true },
  ]
  let action: JSX.Element | null = null
  if (status.phase === 'connecting') {
    action = <button type="button" className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary" disabled>{PANEL_COPY.connecting}</button>
  } else if (status.phase === 'idle' || status.phase === 'error') {
    action = (
      <button type="button" className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary" onClick={onReconnect} disabled={actionBusy}>
        {busy === 'reconnect' ? PANEL_COPY.connecting : status.phase === 'idle' ? PANEL_COPY.connect : PANEL_COPY.retry}
      </button>
    )
  } else if (status.phase === 'connected') {
    action = (
      <button type="button" className="dsh-channels-cfg__btn" onClick={onReconnect} disabled={actionBusy}>
        {busy === 'reconnect' ? PANEL_COPY.reconnecting : PANEL_COPY.reconnect}
      </button>
    )
  }
  return (
    <div className="dsh-channels-cfg__hero">
      <div className="dsh-channels-cfg__heroTop">
        <Pill tone={badge.tone} dot>{badge.text}</Pill>
        <strong>{phaseSummary(status.phase)}</strong>
        <span className="dsh-channels-cfg__spacer" />
        {action}
      </div>
      {status.lastStartError === undefined
        ? null
        : (
            <div className="dsh-channels-cfg__notice dsh-channels-cfg__notice--error">
              {PANEL_COPY.lastError}：<span className="dsh-channels-cfg__mono">{status.lastStartError}</span>
            </div>
          )}
      {status.phase === 'connected'
        ? (
            <div className="dsh-channels-cfg__stats">
              {stats.map(stat => (
                <div className="dsh-channels-cfg__stat" key={stat.label}>
                  <span>{stat.label}</span>
                  <strong className={stat.mono === true ? 'dsh-channels-cfg__mono' : undefined}>{stat.value}</strong>
                </div>
              ))}
            </div>
          )
        : null}
      {status.reasons.length === 0
        ? null
        : (
            <span className={`dsh-channels-cfg__rowSummary${status.level === 'unhealthy' ? ' dsh-channels-cfg__textBad' : ''}`}>
              {PANEL_COPY.healthReasons}：{status.reasons.join('；')}
            </span>
          )}
    </div>
  )
}

/** Status icon in front of one check row. */
function CheckIcon(props: { tone: 'ok' | 'warn' | 'bad' }): JSX.Element {
  return (
    <span className={`dsh-channels-cfg__checkIcon dsh-channels-cfg__checkIcon--${props.tone}`} aria-hidden="true">
      {props.tone === 'ok' ? '✓' : '!'}
    </span>
  )
}

/** Post-connect scope self-check: the gap count, expandable to each scope with its console link. */
function ScopeCheckRow(props: { check: ScopeCheckWire }): JSX.Element {
  const { check } = props
  const [open, setOpen] = useState(false)
  if (check.state === 'ok') {
    return <Row leading={<CheckIcon tone="ok" />} label={PANEL_COPY.scopeCheckOk} />
  }
  if (check.state === 'error') {
    return (
      <Row
        leading={<CheckIcon tone="bad" />}
        label={PANEL_COPY.scopeCheckError}
        summary={<span className="dsh-channels-cfg__mono">{check.error}</span>}
      />
    )
  }
  const required = check.missing.filter(item => item.level === 'required').length
  return (
    <>
      <Row
        leading={<CheckIcon tone={required > 0 ? 'bad' : 'warn'} />}
        label={required > 0
          ? fillCopy(PANEL_COPY.scopeCheckMissingRequired, { n: required })
          : fillCopy(PANEL_COPY.scopeCheckMissing, { n: check.missing.length })}
        summary={required > 0 ? PANEL_COPY.scopeCheckPublish : PANEL_COPY.scopeCheckMissingOptional}
        control={(
          <div className="dsh-channels-cfg__inputRow">
            <button type="button" className="dsh-channels-cfg__more" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? PANEL_COPY.collapse : PANEL_COPY.expand}
            </button>
            <a className="dsh-channels-cfg__btn" href={check.consoleUrl} target="_blank" rel="noreferrer noopener">
              {PANEL_COPY.scopeCheckOpenAll}
            </a>
          </div>
        )}
      />
      {open
        ? (
            <ul className="dsh-channels-cfg__scopeList">
              {check.missing.map(item => (
                <li key={item.scopes.join(',')}>
                  <code className="dsh-channels-cfg__mono">{item.scopes.join(' / ')}</code>
                  {item.level === 'required' ? <Pill tone="bad">{PANEL_COPY.scopeCheckRequired}</Pill> : null}
                  <span>{item.purpose}</span>
                  <a className="dsh-channels-cfg__link" href={item.consoleUrl} target="_blank" rel="noreferrer noopener">
                    {PANEL_COPY.scopeCheckOpenOne}
                  </a>
                </li>
              ))}
            </ul>
          )
        : null}
    </>
  )
}

/** Post-connect native slash-command panel sync: the command count, or the Feishu reason. */
function SlashCommandSyncRow(props: { sync: SlashCommandSyncWire }): JSX.Element {
  const { sync } = props
  return sync.state === 'ok'
    ? (
        <Row
          leading={<CheckIcon tone="ok" />}
          label={PANEL_COPY.slashCommandSyncTitle}
          summary={fillCopy(PANEL_COPY.slashCommandSyncOk, { total: sync.total })}
        />
      )
    : (
        <Row
          leading={<CheckIcon tone="warn" />}
          label={PANEL_COPY.slashCommandSyncTitle}
          summary={<>{PANEL_COPY.slashCommandSyncError}：<span className="dsh-channels-cfg__mono">{sync.error}</span></>}
        />
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
      <span className="dsh-channels-cfg__bannerText">{PANEL_COPY.restartBanner}{keys}</span>
      <button
        type="button"
        className="dsh-channels-cfg__btn"
        onClick={onReconnect}
        disabled={busy !== null || locked}
      >
        {busy === 'reconnect' ? PANEL_COPY.reconnecting : PANEL_COPY.reconnect}
      </button>
    </div>
  )
}

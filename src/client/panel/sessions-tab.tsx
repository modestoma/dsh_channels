/**
 * 「会话与行为」tab：行为 + 内容与附件两组字段（私聊/群聊触发方式、
 * 首次引导、权限切换、附件接收、日志分析接口）。表单字段完全由 Host 描述驱动；
 * 日志分析接口令牌是凭据，单独一张卡片。
 *
 * @module dsh-channels/client/panel/sessions-tab
 */

import { PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import { AnalyzeTokenCard } from './analyze-token-card.tsx'
import { FieldsCard, SaveBar, TabHelp } from './shared.tsx'
import type { AnalyzeTokenView, FormView } from './shared.tsx'

export function SessionsTab(props: { form: FormView; analyzeToken: AnalyzeTokenView }): JSX.Element {
  const { form, analyzeToken } = props
  return (
    <div className="dsh-channels-cfg__tabBody">
      <TabHelp text={PANEL_COPY.sessionsTabHelp} />
      <FieldsCard form={form} groups={TAB_FIELD_GROUPS.sessions} />
      <SaveBar form={form} tab="sessions" />
      <AnalyzeTokenCard panel={form.panel} token={analyzeToken} />
    </div>
  )
}

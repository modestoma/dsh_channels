/**
 * 「模型」tab：模型服务商 / 模型 id / 推理档位 / Agent 预设四个选择器。
 * 选项来自 Host 实时目录（页面外壳负责 provider→model→effort 级联刷新），
 * 目录读取中时在表单上方提示。
 *
 * @module dsh-channels/client/panel/model-tab
 */

import { PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import { FieldsCard, SaveBar, TabHelp } from './shared.tsx'
import type { FormView } from './shared.tsx'

export function ModelTab(props: { form: FormView; catalogBusy: boolean }): JSX.Element {
  const { form, catalogBusy } = props
  return (
    <div className="dsh-channels-cfg__tabBody">
      <TabHelp text={PANEL_COPY.modelTabHelp} />
      {catalogBusy ? <span className="dsh-channels-cfg__help">{PANEL_COPY.catalogLoading}</span> : null}
      <FieldsCard form={form} groups={TAB_FIELD_GROUPS.model} />
      <SaveBar form={form} tab="model" />
    </div>
  )
}

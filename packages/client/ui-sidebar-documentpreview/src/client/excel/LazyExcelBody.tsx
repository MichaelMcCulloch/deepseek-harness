/** Load the spreadsheet renderer only when a supported workbook is opened. */
import { lazy, Suspense, type ReactNode } from 'react'
import { excelFormat } from './format.ts'
import type { ExcelBodyProps } from './body-props.ts'
import { hostFileOf } from '../rpc.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'

export type { ExcelBodyProps, LoadedExcelBodyProps } from './body-props.ts'

const LoadedExcelBody = lazy(async () => ({ default: (await import('./excel.tsx')).ExcelBody }))

/**
 * Load the browser spreadsheet renderer for every registered format.
 * @param props - Complete file bytes and standard document seats.
 * @returns Localized loading state or Excel preview.
 */
export function LazyExcelBody(props: ExcelBodyProps): ReactNode {
  const format = excelFormat(hostFileOf(props.resourceAddress).path)
  const loading = <LoadingIndicator label={props.t('loading')} />
  return <Suspense fallback={loading}>
    <LoadedExcelBody {...props} format={format} loading={loading} />
  </Suspense>
}

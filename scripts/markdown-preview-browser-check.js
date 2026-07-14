async (page) => {
  if (await page.getByRole('textbox').count() === 0) {
    await page.getByRole('button', { name: '新建文件 Ctrl+N' }).click()
  }
  const text = Array.from({ length: 80 }, (_, index) => [
    `# 章节 ${index}`,
    '',
    `这是第 ${index} 节的大文档性能测试段落。${'性能'.repeat(400)}`,
    '',
    '```ts',
    `const value${index} = ${index}`,
    '```',
    '',
    `$$x_${index}^2 + y_${index}^2 = z_${index}^2$$`,
  ].join('\n')).join('\n\n')

  await page.getByRole('textbox').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
  await page.getByRole('button', { name: '预览模式' }).click()
  await page.waitForSelector('[data-preview-block-state]')
  await page.waitForTimeout(1000)

  const initial = await page.locator('[data-preview-block-state]').evaluateAll((blocks) => ({
    total: blocks.length,
    mounted: blocks.filter((block) => block.getAttribute('data-preview-block-state') === 'mounted').length,
    placeholders: blocks.filter((block) => block.getAttribute('data-preview-block-state') === 'placeholder').length,
  }))
  if (initial.total < 70 || initial.placeholders === 0 || initial.mounted >= initial.total) {
    throw new Error(`预览虚拟化未生效：${JSON.stringify(initial)}`)
  }

  await page.getByRole('button', { name: '章节 79', exact: true }).click()
  await page.waitForTimeout(800)
  const afterScroll = await page.locator('[data-preview-block-state]').evaluateAll((blocks) => ({
    mounted: blocks.filter((block) => block.getAttribute('data-preview-block-state') === 'mounted').length,
    last: blocks.at(-1)?.getAttribute('data-preview-block-state'),
  }))
  if (afterScroll.last !== 'mounted' || afterScroll.mounted <= initial.mounted) {
    throw new Error(`滚动后远端块未挂载：${JSON.stringify({ initial, afterScroll })}`)
  }

  return { initial, afterScroll }
}

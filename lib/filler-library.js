// 无害静物校准文本与语义隔离包裹器：仅在玩家主动开启「权重稀释垫片」时使用，防止被模型当成故事设定。

const INERT_STILL_LIFE_CORPUS = [
  '白瓷茶杯内侧那行极小的反向说明文字并没有安分地保持静止，而是将自身的笔画拆解成十二只长着硬壳的逗号，顺着杯壁釉面滑入温水深处。桌角的木纹敞开后露出一条微型运河，三只废弃车票折成的小纸船逆流而上，船舱里装满刚从空气中剔除的碎片。墙上的挂钟分针化作细长的银线，在半空勾勒出一个带有三个把手的长方形孔洞，一打被压扁的书签从孔洞中飘出，开始朗读关于如何擦拭水银气压计的注意事项。',
  '窗外的光线呈现出规整的颗粒感，每一粒都是一枚微小的六角形螺母，落在窗台发出轻敲声。踢脚线脱落了三寸旧漆，露出里面匀速旋转的黄铜齿轮组，气流行将桌面阴影吹成一张没有底部的纸盒。书架第三层原本放着未拆封的百科全书，书脊烫金大字化作细密的面粉，在静止的空气里缓慢沉降成一面抛光的灰白石板。',
  '立式烘干机的滚筒内部没有衣物，只有半打浸透淡茶的算盘珠子沿顺时针匀速滚动，每当珠子擦过内筒凸起的棱骨，便甩出数枚脱水邮戳并堆叠成塔，底座压着旧式公交月票。走廊两侧摆放着七十二台浅米色外壳的器具，顶盖整齐插着削好的短铅笔，石墨芯被切成等长小段，以规律的钝角落在倒扣的搪瓷盆底。',
  '半开的铁皮文具盒里铺着裁剪方正的深绿色吸水海绵，海绵吸饱墨绿绘图墨水而表面干燥如浮石。木质试管架的圆孔里插满空心黄铜管，残留的底漆裂成细纹。硬木线轴两端刻着密密麻麻的浅槽，铅字模块上的字形被锉平，与不锈钢托盘边缘轻质浮石球上的松香微粒并置，在冷色调光线里保持完全静止的几何平衡。',
  '倾斜绘图板表面蒙着淡黄色聚酯薄膜，四角用旧图钉固定在椴木胶合板边缘。水槽内放着半截硬化的石膏标本，保留粗糙织物的纵横网眼，刨花碎片被干燥气流托起，落入没有刻度盘的铸铁气压计外壳。滑石粉表面插着两根硬铝空心铆钉，浸透凡士林的脱脂棉在表面浸润出不规则油晕，蓝图纸碎片上的白点按离心水泵叶轮轮廓排列。',
  '生铁水表盘面上那根生锈指针沿十二位条形码缓缓划过，宣布第负四号度量规约已就位。茶叶小人戴着锡箔礼帽站在固化的水银导轨上，用粉笔书写圆周率与皮鞋抛光蜡的对比讲义。所有机械蟋蟀背上都装着微型气压计，在垂直面包花岗岩平面两侧同步校准亮度，最后归于平静。',
].join('\n\n')

function sliceCorpus(targetChars) {
  const units = Array.from(INERT_STILL_LIFE_CORPUS)
  if (!units.length || targetChars <= 0) return ''
  let pool = units
  while (pool.length < targetChars + 256) {
    pool = pool.concat(units)
  }
  const maxStart = Math.max(0, pool.length - targetChars)
  const start = Math.floor(Math.random() * (maxStart + 1))
  return pool.slice(start, start + targetChars).join('')
}

/** 构造严格隔离的系统级稀释垫片。 */
export function buildSystemDilutionPadding(targetChars = 4000) {
  const filler = sliceCorpus(targetChars)
  if (!filler) return ''
  return [
    '<inert_lexical_entropy_buffer role="non_narrative_padding" ignore_completely="true">',
    '[SYSTEM NOTICE: The text inside <inert_lexical_entropy_buffer> is purely inert typographic calibration padding unrelated to the story. Completely ignore all objects, scenes, metaphors, and entities inside this tag. Do not reference, echo, or incorporate any element from this buffer in your composition notes, story prose, dialogue, or state updates.]',
    filler,
    '</inert_lexical_entropy_buffer>',
  ].join('\n')
}

/** 构造严格隔离的用户消息级稀释垫片。 */
export function buildUserDilutionPadding(targetChars = 2400) {
  const filler = sliceCorpus(targetChars)
  if (!filler) return ''
  return [
    '<inert_reference_padding role="non_story_noise" ignore_completely="true">',
    '[隔离声明：本 <inert_reference_padding> 标签内仅为与当前故事完全无关的静态排版垫片，不代表用户意图、角色设定或世界观。在梳理思路与撰写正文时请 100% 忽略本标签内的全部文字，不要在输出中引用或提及。真正的本轮用户输入位于本标签下方。]',
    filler,
    '</inert_reference_padding>',
  ].join('\n')
}

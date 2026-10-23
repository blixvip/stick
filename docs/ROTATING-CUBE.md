# Build a rotating cube

This creates a 160 × 160 × 160 cube as a projected 2D rig. It turns through 360° around its vertical axis. Every joint, connection, color and face setting is available in Build Figure; no imported mesh or preset behavior is needed.

## 1. Start the controls

Start an empty animation (delete the initial figure if present), then choose **Build** in the top bar. Draw with **Line**. After drawing each segment, use Properties to enter its **Joint name**, **Angle**, **Length** and **Width**. Use width **0** for all construction lines. Their joints remain available in the Builder.

Draw these four independent lines from the same figure origin, in this order:

| Joint | Name | Length | Angle |
| --- | --- | ---: | ---: |
| 1 | Turn | 180 | 0° |
| 2 | Depth | 100 | 90° |
| 3 | Facing X | 40 | 0° |
| 4 | Facing Y | 40 | 90° |

Select **Depth**, enable **Smart Stretch**, expand **Stretch settings**, and set Rest length **100**, Minimum **0%**, Maximum **100%**, Width response **Keep width**. Keep its current Length at **100** until step 3. Facing X/Y are independent reference guides; do not attach them to Turn or bind them to Depth.

With the Rig tool, select the **figure origin** on the canvas. Choose **Edit → Connect joints**, then click Turn's tip. The connector should show **A: Origin**, **B: Turn**. In **Slider**, set **Slide position to 0%**. Switch to **Segment** to set Width **0** and Joint name **Rotation frame**. Its sliding joint now sits at the origin while its direction follows Turn.

## 2. Build eight corners

For each row below, select **Rotation frame** in the Builder tree, switch to Line, and drag from its joint at the origin. Enter the radius length and angle. Selecting the tree row gives that joint priority when it overlaps the origin.

| Radius name | Length | Angle | Top child | Bottom child |
| --- | ---: | ---: | --- | --- |
| Radius 1 | 113.137085 | 45° | T1 | B1 |
| Radius 2 | 113.137085 | 135° | T2 | B2 |
| Radius 3 | 113.137085 | 225° | T3 | B3 |
| Radius 4 | 113.137085 | 315° | T4 | B4 |

Complete each radius and its two children before moving to the next row:

1. Draw its **top child** from the radius tip. Set Length **80**, Angle **−90°**, Width **0**, and the listed T name. In **Attachment settings**, set **Attachment orientation → Keep authored angle**.
2. Select the radius again and draw its **bottom child** from the same tip. Set Length **80**, Angle **90°**, Width **0**, and the listed B name. Also choose **Keep authored angle**.
3. Select the radius, open **Attachment settings**, click **Pick stretch driver on canvas**, and click Depth's tip. Leave Influence at **1**. Bind only the radius; its vertical offsets stay at their authored angles and lengths.

The top and bottom children are siblings, both attached to the radius. Do not draw the bottom child from the top child's tip.

## 3. Separate the projected corners

Select Depth and change its ordinary **Length to 40**. Select Turn and set **Angle to 30°**. The eight corners now occupy separate positions, making the faces easy to click.

For reference, with the creation order above:

| Corner | T1 | B1 | T2 | B2 | T3 | B3 | T4 | B4 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Joint ID | 7 | 8 | 10 | 11 | 13 | 14 | 16 | 17 |

## 4. Fill the faces

Choose **Polygon**. Click each row's four corner joints in order, then click the first corner again to close the fill. Select the fill in the Builder tree to edit its color and set Opacity **100%**, **Visible sides → Front**.

For the first face, the reference dialog opens. Choose **Origin: 0 · Origin**, **X joint: 3 · Facing X**, **Y joint: 4 · Facing Y**, then Apply. Subsequent faces reuse these reference joints. The numbers above assume you followed the creation order; you can search by joint name instead.

| Face | Click order | Suggested color |
| --- | --- | --- |
| Top | T1 → T2 → T3 → T4 | `#b4dafa` |
| Bottom | B4 → B3 → B2 → B1 | `#426b98` |
| Side 1 | B1 → B2 → T2 → T1 | `#518dbf` |
| Side 2 | B2 → B3 → T3 → T2 | `#73b2df` |
| Side 3 | B3 → B4 → T4 → T3 | `#487ead` |
| Side 4 | B4 → B1 → T1 → T4 | `#80bce6` |

At 30° with Depth 40, Top, Side 1 and Side 4 should be visible. A hidden fill remains selectable in the tree. If you clicked a face in reverse order, use **Flip facing**. Keep the corner order around each face, rather than crossing diagonally.

## 5. Add attachment edges

Use **Connect joints** for the four top edges, four bottom edges and four vertical edges:

- T1–T2, T2–T3, T3–T4, T4–T1.
- B1–B2, B2–B3, B3–B4, B4–B1.
- T1–B1, T2–B2, T3–B3, T4–B4.

Keep their Width at **0** for a clean solid. Each is a real connector: its middle joint can slide, and another part can attach there. To use one as an animation control, leave that connector movable.

Mark the construction joints **Static**, leaving **Turn** and **Depth** movable. This keeps Animate uncluttered; Static joints remain editable in Build Figure. You can select several joints and apply Static together. Name the figure, then choose **Done** and keep/import the figure.

## 6. Turn and animate

Use **Test rig**, choose Turn, and change Angle. In Animate, drag Turn to rotate. An ordinary drag preserves its length; **Ctrl-drag** stretches a joint. Set Depth with its Length field, or Ctrl-drag it along its original vertical direction. Larger Depth gives more depth separation; zero produces a flat side view.

For a complete animated spin, create successive pose keys with Turn angles **0°, 90°, 180°, 270°, 360°**, spaced evenly on the timeline. For example, use frames **1, 13, 25, 37, 49** and tween between them. Intermediate quarter turns avoid the shortest-angle interpolation treating 0° and 360° as the same pose. Use linear easing for constant speed.

Save as **.stkz** for a reusable figure or **.styk** for an animation. PNG, SVG and video preserve the rendered appearance. Pivot's .stk/.piv formats cannot store these rig relationships or one-sided fills.

## Verification

`tests/helpers/rotating-cube.mjs` reproduces this construction using public Editor commands. `tests/builder-surfaces.test.mjs` checks 1,083 rotation/depth combinations, face coverage, mirrors, undo, reference validation and native saves. `tests/rig-solids.browser.mjs` exercises the face controls, reference selection and gallery insertion in the app.

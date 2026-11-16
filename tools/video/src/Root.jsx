import { Composition } from "remotion";
import { Video, TOTAL } from "./Video";
import { Video2, TOTAL2 } from "./Video2";
export const Root = () => (<>
  <Composition id="Pravaha080" component={Video} durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
  <Composition id="Pravaha088" component={Video2} durationInFrames={TOTAL2} fps={30} width={1920} height={1080} />
</>);

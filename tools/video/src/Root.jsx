import { Composition } from "remotion";
import { Video, TOTAL } from "./Video";
import { Video2, TOTAL2 } from "./Video2";
import { Tour, TOTAL3 } from "./Tour";
export const Root = () => (<>
  <Composition id="Pravaha080" component={Video} durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
  <Composition id="Pravaha088" component={Video2} durationInFrames={TOTAL2} fps={30} width={1920} height={1080} />
  <Composition id="PravahaTour" component={Tour} durationInFrames={TOTAL3} fps={30} width={1920} height={1080} />
</>);

import Collect from './collect';
import { PageContext } from '../types/index';
export default class CollectAssets extends Collect {
    collectId: SA.Audit.CollectorsIds;
    static get id(): SA.Audit.CollectorsIds;
    static collect(pageContext: PageContext): Promise<SA.Traces.CollectAssetsTraces | undefined>;
}

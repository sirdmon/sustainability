export default class Audit {
    static get meta(): SA.Audit.Meta;
    static audit(traces: SA.Traces.Traces): Promise<SA.Audit.Result | undefined> | SA.Audit.Result | undefined;
}

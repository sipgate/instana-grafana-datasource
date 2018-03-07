import _ from 'lodash';

export default class InstanaDatasource {
  id: number;
  name: string;
  url: string;
  apiToken: string;
  currentTime: () => number;
  snapshotCache: Object;
  cacheSnapshotData: Object;
  lastFetchedFromAPI: boolean;
  dashboardMode: boolean = false;

  MAX_NUMBER_OF_METRICS_FOR_CHARTS = 800;
  CACHE_MAX_AGE = 60000;

  rollupDurationThresholds = [
    {
      availableFor: 1000 * 60 * 10 + 3000, // 10m + 3s (to give it some slack when deactivating live mode)
      rollup: 1000, // 1s
      label: '1s'
    },
    {
      availableFor: 1000 * 60 * 60 * 24, // 1d
      rollup: 1000 * 5, // 5s
      label: '5s'
    },
    {
      availableFor: 1000 * 60 * 60 * 24 * 31, // 1 month
      rollup: 1000 * 60, // 1m
      label: '1min'
    },
    {
      availableFor: 1000 * 60 * 60 * 24 * 31 * 3, // 3 months
      rollup: 1000 * 60 * 5, // 5m
      label: '5min'
    },
    {
      availableFor: Number.MAX_VALUE, // forever
      rollup: 1000 * 60 * 60, // 1h
      label: '1h'
    }
  ];

  /** @ngInject */
  constructor(instanceSettings, private backendSrv, private templateSrv, private $q) {
    this.name = instanceSettings.name;
    this.id = instanceSettings.id;
    this.url = instanceSettings.jsonData.url;
    this.apiToken = instanceSettings.jsonData.apiToken;
    this.snapshotCache = {};
    this.cacheSnapshotData = {};
    this.currentTime = () => { return new Date().getTime() };
  }

  dispatchToLocalCache = (id) => {
    this.setDashboardMode();

    if (!this.snapshotCache)
      this.snapshotCache = {};
    if (!this.snapshotCache[id])
      this.snapshotCache[id] = {};

    const result = (query, data) => {      
      this.snapshotCache[id][query] = data;
    }

    return result;
  }

  initializeCache = (id) =>  {
    this.dashboardMode = true;
    this.registerCacheSnapshotDataCallback(id, this.dispatchToLocalCache(id));
  }

  registerCacheSnapshotDataCallback = (id, callback) => {
    this.cacheSnapshotData[id] = callback;
  }

  setDashboardMode = () => { this.dashboardMode = true };

  inDashboardMode = () => { return this.dashboardMode; }

  cacheSnapshotDataCallback = (id) => { return this.cacheSnapshotData[id] };

  getSnapshotCache = () => { return this.snapshotCache; };

  wasLastFetchedFromApi = () => { return this.lastFetchedFromAPI; }

  setLastFetchedFromApi = (value) => { this.lastFetchedFromAPI = value; }

  request(method, url, requestId?) {
    var options: any = {
      url: this.url + url,
      method: method,
      requestId: requestId,
    };

    options.headers = {
      Authorization: 'apiToken ' + this.apiToken,
    };

    return this.backendSrv.datasourceRequest(options);
  }

  query(options) {
    if (Object.keys(options.targets[0]).length === 0)
      return this.$q.resolve({ data: [] });

    // Convert ISO 8601 timestamps to millis.
    const fromInMs = new Date(options.range.from).getTime();
    const toInMs = new Date(options.range.to).getTime();

    return this.$q.all(
      _.map(options.targets, target => {
        // For every target, fetch snapshots that in the selected timeframe that satisfy the lucene query.
        return this.fetchSnapshotsForTarget(target, fromInMs, toInMs)
          .then(snapshots => {
            return { 
              'target': target,
              'snapshots': snapshots
            };
          });
      })
    ).then(targetsWithSnapshots => {
      return this.$q.all(
        _.map(targetsWithSnapshots, targetWithSnapshots => {
          // For every target with all snapshots that were returned by the lucene query...

          // Cache the data if fresh
          if (this.wasLastFetchedFromApi()) {
            if (!this.cacheSnapshotDataCallback(targetWithSnapshots.target.refId)) {
              this.initializeCache(targetWithSnapshots.target.refId);
            }

            this.cacheSnapshotDataCallback(targetWithSnapshots.target.refId)(this.buildQuery(targetWithSnapshots.target), { time: toInMs, snapshots: targetWithSnapshots.snapshots });
          }

          return this.$q.all(
            _.map(targetWithSnapshots.snapshots, snapshot => {

              // ...fetch the metric data for every snapshot in the results.
              return this.fetchMetricsForSnapshot(snapshot.snapshotId, targetWithSnapshots.target.metric.key, fromInMs, toInMs)
                .then(response => {
                  var result = {
                    'target': snapshot.label,
                    'datapoints': _.map(response.data.values, value => [value.value, value.timestamp])
                  };
                  return result;
                })
            })
          );
        })
      );
    }).then(results => {
      // Flatten the list as Grafana expects a list of targets with corresponding datapoints.
      return { data: [].concat.apply([], results) };
    });
  }

  fetchSnapshotsForTarget(target, from, to) {
    const query = this.buildQuery(target);

    if ( (!this.inDashboardMode() && this.globalCacheCopyAvailable(target, query)) ||  
         (this.inDashboardMode() && this.localCacheCopyAvailable(target, query))) {

      this.setLastFetchedFromApi(false);
      return this.inDashboardMode()
        ? this.$q.resolve(this.snapshotCache[target.refId][query].snapshots)
        : this.$q.resolve(target.snapshotCache[query].snapshots);
    }

    this.setLastFetchedFromApi(true);
    const fetchSnapshotsUrl = '/api/snapshots?from=' + from + '&to=' + to + '&q=' + query;
    const fetchSnapshotContextsUrl = '/api/snapshots/context?q=' + encodeURIComponent(target.entityQuery + ' AND entity.pluginId:' + target.entityType) + '&time=' + to;

    return this.$q.all([this.request('GET', fetchSnapshotsUrl), this.request('GET', fetchSnapshotContextsUrl)]).then(snapshotsWithContextsResponse => {
      return this.$q.all(
        _.map(snapshotsWithContextsResponse[0].data, snapshotId => {
          const fetchSnapshotUrl = '/api/snapshots/' + snapshotId + '?time=' + to;

          return this.request('GET', fetchSnapshotUrl).then(snapshotResponse => {
            return {
              'snapshotId': snapshotId,
              'label': snapshotResponse.data.label + this.getHostSuffix(snapshotsWithContextsResponse[1].data, snapshotId)
            };
          });
        })
      )
    });
  }

  globalCacheCopyAvailable(target, query) {
    return target.snapshotCache && _.includes(Object.keys(target.snapshotCache), query) && this.currentTime() - target.snapshotCache[query].time < this.CACHE_MAX_AGE;
  }

  localCacheCopyAvailable(target, query) {
    return this.snapshotCache[target.refId] && _.includes(Object.keys(this.snapshotCache[target.refId]), query) && this.currentTime() - this.snapshotCache[target.refId][query].time < this.CACHE_MAX_AGE;
  }

  buildQuery(target) {
    return encodeURIComponent(target.entityQuery + ' AND entity.pluginId:' + target.entityType);
  }

  getHostSuffix(contexts, snapshotId) {
    const host = _.find(contexts, context => context.snapshotId == snapshotId).host;
    if (!host)
      return '';
    
    return ' (on host "' + host + '")';
  }

  fetchMetricsForSnapshot(snapshotId, metric, from, to) {
    const rollup = this.getDefaultMetricRollupDuration(from, to).rollup;
    const url = '/api/metrics?metric=' + metric + '&from=' + from + '&to=' + to + '&rollup=' + rollup + '&snapshotId=' + snapshotId;
    
    return this.request('GET', url);
  }

  annotationQuery(options) {
    throw new Error("Annotation Support not implemented yet.");
  }

  metricFindQuery(query: string) {
    throw new Error("Template Variable Support not implemented yet.");
  }

  testDatasource() {
    return this.request('GET', '/api/snapshots/non-existing-snapshot-id?time=0')
    .then(
      // We always expect an error response, either a 404 (Not Found) or a 401 (Unauthorized).
      result => {
        return {
          status: 'error',
          message: 'Error connecting to the Instana API.',
          title: 'Error'
        };
      },
      error => {
        if (error.status === 404) {
          return {
            status: 'success',
            message: 'Successfully connected to the Instana API.',
            title: 'Success'
          };
        }
        else if (error.status === 401) {
          return {
            status: 'error',
            message: 'Unauthorized. Please verify the API Token.',
            title: 'Error'
          };
        }
        else {
          return {
            status: 'error',
            message: 'Error connecting to the Instana API.',
            title: 'Error'
          }
        }
      });
  }

  getDefaultMetricRollupDuration(from, to, minRollup = 1000) { 
    // Ignoring time differences for now since small time differences
    // can be accepted. This time is only used to calculate the rollup.
    const now = Date.now();
    const windowSize = to - from;

    let availableRollupDefinitions = this.rollupDurationThresholds.filter(
      rollupDefinition => from >= now - rollupDefinition.availableFor
    );
    if (minRollup > 1000) {
      availableRollupDefinitions = availableRollupDefinitions.filter(
        rollupDefinition => rollupDefinition.rollup != null && rollupDefinition.rollup >= minRollup
      );
    }
  
    for (let i = 0, len = availableRollupDefinitions.length; i < len; i++) {
      // this works because the rollupDurationThresholds array is sorted by rollup
      // the first rollup matching the requirements is returned
      const rollupDefinition = availableRollupDefinitions[i];
      const rollup = rollupDefinition && rollupDefinition.rollup ? rollupDefinition.rollup : 1000;
      if (windowSize / rollup <= this.MAX_NUMBER_OF_METRICS_FOR_CHARTS) {
        return rollupDefinition;
      }
    }
  
    return this.rollupDurationThresholds[this.rollupDurationThresholds.length - 1];
  }
}
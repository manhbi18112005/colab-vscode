/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  FileChangeEvent,
  Uri,
  WorkspaceConfiguration,
  WorkspaceFoldersChangeEvent,
} from 'vscode';
import { Variant } from '../../colab/api';
import { TestEventEmitter } from '../../test/helpers/events';
import { TestUri } from '../../test/helpers/uri';
import {
  FileChangeType,
  FileType,
  newVsCodeStub,
  VsCodeStub,
} from '../../test/helpers/vscode';
import { DirectoryContents } from '../client/converters';
import {
  Contents,
  ContentsApi,
  ContentsGetTypeEnum,
  ResponseError,
} from '../client/generated';
import { ColabAssignedServer } from '../servers';
import { ContentsFileSystemProvider, TEST_ONLY } from './file-system';
import { JupyterConnectionManager } from './sessions';

const DEFAULT_SERVER: ColabAssignedServer = {
  id: randomUUID(),
  label: 'Colab GPU A100',
  variant: Variant.GPU,
  accelerator: 'A100',
  endpoint: 'm-s-foo',
  connectionInformation: {
    baseUrl: TestUri.parse('https://example.com'),
    token: '123',
    tokenExpiry: new Date(Date.now() + 1000),
    headers: {},
  },
  dateAssigned: new Date(),
};

const FOO_CONTENT_DIR: Contents = {
  name: 'foo',
  path: '/foo',
  type: 'directory',
  writable: true,
  created: '2025-12-11T14:34:40Z',
  lastModified: '2025-12-16T14:30:53.932129Z',
  size: undefined,
  mimetype: '',
  content: '',
  format: '',
};

const ROOT_CONTENT_DIR: Contents = {
  ...FOO_CONTENT_DIR,
  name: 'content',
  path: '/',
};

const FOO_CONTENT_FILE: Contents = {
  name: 'foo.txt',
  path: '/foo.txt',
  type: 'file',
  writable: true,
  created: '2025-12-16T14:30:53.932129Z',
  lastModified: '2025-12-11T14:34:40Z',
  size: 0,
  mimetype: 'text/plain',
  content: '',
  format: '',
};

const CONTENT_DIR: {
  withoutContents: Contents;
  withContents: DirectoryContents;
} = {
  withoutContents: FOO_CONTENT_DIR,
  withContents: {
    ...FOO_CONTENT_DIR,
    type: 'directory',
    content: [FOO_CONTENT_FILE],
  },
};

const FORBIDDEN = new ResponseError(new Response(undefined, { status: 403 }));
const NOT_FOUND = new ResponseError(new Response(undefined, { status: 404 }));
const CONFLICT = new ResponseError(new Response(undefined, { status: 409 }));
const TEAPOT = new ResponseError(new Response(undefined, { status: 418 }));
const WATCH_POLL_INTERVAL_MS = TEST_ONLY.WATCH_POLL_INTERVAL_MS;

describe('ContentsFileSystemProvider', () => {
  let vs: VsCodeStub;
  let jupyterStub: sinon.SinonStubbedInstance<JupyterConnectionManager>;
  let workspaceEmitter: TestEventEmitter<WorkspaceFoldersChangeEvent>;
  let connectionEmitter: TestEventEmitter<string[]>;
  let fs: ContentsFileSystemProvider;
  let listener: sinon.SinonStub<[FileChangeEvent[]]>;

  function stubClient(
    endpoint: string,
  ): sinon.SinonStubbedInstance<ContentsApi> {
    const contentsStub = sinon.createStubInstance(ContentsApi);
    jupyterStub.get.withArgs(endpoint).resolves(contentsStub);
    jupyterStub.getOrCreate.withArgs(endpoint).resolves(contentsStub);
    return contentsStub;
  }

  beforeEach(() => {
    vs = newVsCodeStub();
    workspaceEmitter = new TestEventEmitter();
    vs.workspace.onDidChangeWorkspaceFolders.callsFake(workspaceEmitter.event);
    jupyterStub = sinon.createStubInstance(JupyterConnectionManager);
    connectionEmitter = new TestEventEmitter();
    // Needed to work around the property being readonly.
    Object.defineProperty(jupyterStub, 'onDidRevokeConnections', {
      value: sinon.stub(),
    });
    jupyterStub.onDidRevokeConnections.callsFake(connectionEmitter.event);
    fs = new ContentsFileSystemProvider(vs.asVsCode(), jupyterStub);
    listener = sinon.stub();
    fs.onDidChangeFile(listener);
  });

  afterEach(() => {
    fs.dispose();
    sinon.restore();
  });

  it('disposes workspace listener when disposed', () => {
    expect(workspaceEmitter.hasListeners()).to.be.true;

    fs.dispose();

    expect(workspaceEmitter.hasListeners()).to.be.false;
  });

  it('disposes connection listener when disposed', () => {
    expect(connectionEmitter.hasListeners()).to.be.true;

    fs.dispose();

    expect(connectionEmitter.hasListeners()).to.be.false;
  });

  describe('onDidChangeWorkspaceFolders', () => {
    it('ignores non-Colab folder removals', () => {
      workspaceEmitter.fire({
        added: [],
        removed: [
          { index: 0, name: 'foo', uri: TestUri.parse('file:///usr/home') },
        ],
      });

      sinon.assert.notCalled(jupyterStub.drop);
    });

    it('drops connections to Colab folders that are removed', () => {
      workspaceEmitter.fire({
        added: [],
        removed: [
          {
            uri: TestUri.parse('colab://m-s-foo/'),
            name: 'Colab CPU',
            index: 0,
          },
        ],
      });

      sinon.assert.calledOnceWithExactly(jupyterStub.drop, 'm-s-foo', true);
    });
  });

  describe('onDidRevokeConnection', () => {
    it("removes matching workspace folder when it's the only one", () => {
      vs.workspace.workspaceFolders = [
        {
          uri: TestUri.parse('colab://m-s-foo/'),
          name: 'Colab CPU',
          index: 0,
        },
      ];

      connectionEmitter.fire(['m-s-foo']);

      sinon.assert.calledWith(vs.workspace.updateWorkspaceFolders, 0, 1);
    });

    it("removes matching workspace folder when it's one of many", () => {
      vs.workspace.workspaceFolders = [
        {
          uri: TestUri.parse('colab://m-s-foo/'),
          name: 'Colab CPU',
          index: 0,
        },
        {
          uri: TestUri.parse('colab://m-s-bar/'),
          name: 'Colab GPU',
          index: 1,
        },
      ];

      connectionEmitter.fire(['m-s-bar']);

      sinon.assert.calledWith(vs.workspace.updateWorkspaceFolders, 0, 2, {
        uri: TestUri.parse('colab://m-s-foo/'),
        name: 'Colab CPU',
      });
    });

    it("removes matching workspace folder when it's one of many including other folders", () => {
      vs.workspace.workspaceFolders = [
        {
          uri: TestUri.parse('colab://m-s-foo/'),
          name: 'Colab CPU',
          index: 0,
        },
        {
          uri: TestUri.parse('file://usr/home/'),
          name: 'Not Colab',
          index: 1,
        },
        {
          uri: TestUri.parse('colab://m-s-bar/'),
          name: 'Colab GPU',
          index: 2,
        },
      ];

      connectionEmitter.fire(['m-s-foo', 'm-s-bar']);

      sinon.assert.calledWith(vs.workspace.updateWorkspaceFolders, 0, 3, {
        uri: TestUri.parse('file://usr/home/'),
        name: 'Not Colab',
      });
    });

    it("no-ops when the removed server doesn't map to a workspace folder", () => {
      vs.workspace.workspaceFolders = [
        {
          uri: TestUri.parse('colab://m-s-foo/'),
          name: 'Colab CPU',
          index: 0,
        },
      ];

      connectionEmitter.fire(['m-s-bar']);

      sinon.assert.notCalled(vs.workspace.updateWorkspaceFolders);
    });
  });

  describe('mount', () => {
    it('throws when disposed', () => {
      fs.dispose();

      expect(() => {
        fs.mount(DEFAULT_SERVER);
      }).to.throw(/disposed/);
    });

    it('no-ops for servers that have already been mounted', () => {
      vs.workspace.getWorkspaceFolder.returns({
        uri: TestUri.parse(`colab://${DEFAULT_SERVER.endpoint}/`),
        name: DEFAULT_SERVER.label,
        index: 0,
      });

      fs.mount(DEFAULT_SERVER);
    });

    it('adds the first mounted server to a new workspace', () => {
      vs.workspace.getWorkspaceFolder.returns(undefined);
      vs.workspace.workspaceFolders = undefined;
      vs.workspace.updateWorkspaceFolders
        .withArgs(0, 0, {
          uri: uriStringMatch(`colab://${DEFAULT_SERVER.endpoint}/content`),
          name: DEFAULT_SERVER.label,
        })
        .returns(true);

      fs.mount(DEFAULT_SERVER);

      sinon.assert.calledOnce(vs.workspace.updateWorkspaceFolders);
    });

    it('adds the first mounted server to an existing empty workspace', () => {
      vs.workspace.getWorkspaceFolder.returns(undefined);
      vs.workspace.workspaceFolders = [];
      vs.workspace.updateWorkspaceFolders
        .withArgs(0, 0, {
          uri: uriStringMatch(`colab://${DEFAULT_SERVER.endpoint}/content`),
          name: DEFAULT_SERVER.label,
        })
        .returns(true);

      fs.mount(DEFAULT_SERVER);

      sinon.assert.calledOnce(vs.workspace.updateWorkspaceFolders);
    });

    it('adds an additional mounted server to the workspace', () => {
      vs.workspace.getWorkspaceFolder.returns(undefined);
      vs.workspace.workspaceFolders = [
        {
          uri: TestUri.parse('colab://m-s-foo/content'),
          name: 'Colab CPU',
          index: 0,
        },
      ];
      vs.workspace.updateWorkspaceFolders
        .withArgs(1, 0, {
          uri: uriStringMatch(`colab://${DEFAULT_SERVER.endpoint}/content`),
          name: DEFAULT_SERVER.label,
        })
        .returns(true);

      fs.mount(DEFAULT_SERVER);

      sinon.assert.calledOnce(vs.workspace.updateWorkspaceFolders);
    });

    it('throws if workspace cannot be added', () => {
      vs.workspace.getWorkspaceFolder.returns(undefined);
      vs.workspace.workspaceFolders = [];
      vs.workspace.updateWorkspaceFolders.returns(false);

      expect(() => {
        fs.mount(DEFAULT_SERVER);
      }).to.throw(/mount/);
    });
  });

  describe('watch', () => {
    let fakeClock: sinon.SinonFakeTimers;

    async function flushWatchRun() {
      await fakeClock.tickAsync(0);
    }

    function recreateFsWithWatchConfig(options: {
      readonly pollIntervalMs?: number;
      readonly snapshotRequestConcurrency?: number;
      readonly maxSnapshotEntries?: number;
    }): void {
      fs.dispose();
      const get = ((section: string, defaultValue?: unknown) => {
        if (typeof defaultValue !== 'number') {
          return defaultValue;
        }
        let value: number;
        switch (section) {
          case 'fileWatchPollIntervalMs':
            value = options.pollIntervalMs ?? defaultValue;
            break;
          case 'fileWatchSnapshotRequestConcurrency':
            value = options.snapshotRequestConcurrency ?? defaultValue;
            break;
          case 'fileWatchMaxSnapshotEntries':
            value = options.maxSnapshotEntries ?? defaultValue;
            break;
          default:
            value = defaultValue;
        }
        return value;
      }) as WorkspaceConfiguration['get'];
      vs.workspace.getConfiguration.withArgs('colab').returns({
        get,
      } as Pick<WorkspaceConfiguration, 'get'> as WorkspaceConfiguration);
      fs = new ContentsFileSystemProvider(vs.asVsCode(), jupyterStub);
      listener = sinon.stub();
      fs.onDidChangeFile(listener);
    }

    function stubWatchedRootDirectory(): {
      contentsStub: sinon.SinonStubbedInstance<ContentsApi>;
      rootContents: DirectoryContents;
      fooContents: DirectoryContents;
    } {
      const contentsStub = stubClient('m-s-foo');
      const rootContents: DirectoryContents = {
        ...ROOT_CONTENT_DIR,
        type: 'directory',
        content: [],
      };
      const fooContents: DirectoryContents = {
        ...FOO_CONTENT_DIR,
        type: 'directory',
        content: [],
      };
      contentsStub.get.callsFake((request) => {
        if (request.path === '/' && request.content === 0) {
          return Promise.resolve(ROOT_CONTENT_DIR);
        }
        if (
          request.path === '/' &&
          request.type === ContentsGetTypeEnum.Directory
        ) {
          return Promise.resolve(rootContents);
        }
        if (
          request.path === '/foo' &&
          request.type === ContentsGetTypeEnum.Directory
        ) {
          return Promise.resolve(fooContents);
        }
        return Promise.reject(
          new Error(
            `Unexpected contents.get request: ${JSON.stringify(request)}`,
          ),
        );
      });
      return { contentsStub, rootContents, fooContents };
    }

    beforeEach(() => {
      fakeClock = sinon.useFakeTimers({
        toFake: ['setInterval', 'clearInterval', 'setTimeout'],
      });
    });

    afterEach(() => {
      fakeClock.restore();
    });

    it('throws when disposed', () => {
      fs.dispose();

      expect(() => {
        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
      }).to.throw(/disposed/);
    });

    it('throws file system not found errors for VS Code files', () => {
      expect(() => {
        fs.watch(TestUri.parse('colab://m-s-foo/.vscode/launch.json'), {
          recursive: false,
          excludes: [],
        });
      }).to.throw(/FileNotFound/);
    });

    it('returns a disposable and does not emit during the initial snapshot', async () => {
      stubWatchedRootDirectory();

      const watch = fs.watch(TestUri.parse('colab://m-s-foo/'), {
        recursive: false,
        excludes: [],
      });

      expect(watch).to.have.property('dispose');
      await flushWatchRun();

      sinon.assert.notCalled(listener);
    });

    it('uses the configured watch poll interval', async () => {
      recreateFsWithWatchConfig({ pollIntervalMs: 25 });
      const { rootContents } = stubWatchedRootDirectory();

      fs.watch(TestUri.parse('colab://m-s-foo/'), {
        recursive: false,
        excludes: [],
      });
      await flushWatchRun();
      listener.resetHistory();

      rootContents.content = [FOO_CONTENT_FILE];
      await fakeClock.tickAsync(24);
      sinon.assert.notCalled(listener);

      await fakeClock.tickAsync(1);
      sinon.assert.calledOnceWithMatch(listener, [
        {
          type: FileChangeType.Created,
          uri: uriStringMatch('colab://m-s-foo/foo.txt'),
        },
      ]);
    });

    it('passes the poll abort signal to Jupyter contents requests', async () => {
      const { contentsStub } = stubWatchedRootDirectory();

      fs.watch(TestUri.parse('colab://m-s-foo/'), {
        recursive: false,
        excludes: [],
      });
      await flushWatchRun();

      for (const call of contentsStub.get.getCalls()) {
        expect(call.args[1])
          .to.have.property('signal')
          .that.is.instanceOf(AbortSignal);
      }
    });

    it('stops recursive snapshot collection at the configured entry cap', async () => {
      recreateFsWithWatchConfig({ maxSnapshotEntries: 1 });
      const { contentsStub, rootContents } = stubWatchedRootDirectory();
      rootContents.content = [FOO_CONTENT_DIR];

      fs.watch(TestUri.parse('colab://m-s-foo/'), {
        recursive: true,
        excludes: [],
      });
      await flushWatchRun();

      sinon.assert.neverCalledWithMatch(contentsStub.get, {
        path: '/foo',
        type: ContentsGetTypeEnum.Directory,
      });
    });

    it('limits recursive snapshot directory requests', async () => {
      recreateFsWithWatchConfig({ snapshotRequestConcurrency: 2 });
      const contentsStub = stubClient('m-s-foo');
      const childDirectories: Contents[] = ['a', 'b', 'c'].map((name) => ({
        ...FOO_CONTENT_DIR,
        name,
        path: `/${name}`,
      }));
      const rootContents: DirectoryContents = {
        ...ROOT_CONTENT_DIR,
        type: 'directory',
        content: childDirectories,
      };
      let inFlight = 0;
      let maxInFlight = 0;
      contentsStub.get.callsFake(async (request) => {
        if (request.path === '/' && request.content === 0) {
          return ROOT_CONTENT_DIR;
        }
        if (
          request.path === '/' &&
          request.type === ContentsGetTypeEnum.Directory
        ) {
          return rootContents;
        }
        if (
          childDirectories.some((entry) => entry.path === request.path) &&
          request.type === ContentsGetTypeEnum.Directory
        ) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return {
            ...FOO_CONTENT_DIR,
            name: request.path.slice(1),
            path: request.path,
            type: 'directory',
            content: [],
          };
        }
        return Promise.reject(
          new Error(
            `Unexpected contents.get request: ${JSON.stringify(request)}`,
          ),
        );
      });

      fs.watch(TestUri.parse('colab://m-s-foo/'), {
        recursive: true,
        excludes: [],
      });
      await flushWatchRun();

      expect(maxInFlight).to.equal(2);
    });

    it('does not create a Jupyter client while polling watches', async () => {
      fs.watch(TestUri.parse('colab://m-s-foo/'), {
        recursive: false,
        excludes: [],
      });

      await flushWatchRun();

      sinon.assert.calledWith(jupyterStub.get, 'm-s-foo');
      sinon.assert.notCalled(jupyterStub.getOrCreate);
      sinon.assert.notCalled(listener);
    });

    it('uses the first existing client poll as the initial snapshot', async () => {
      fs.watch(TestUri.parse('colab://m-s-foo/'), {
        recursive: false,
        excludes: [],
      });
      await flushWatchRun();

      const { rootContents } = stubWatchedRootDirectory();
      rootContents.content = [FOO_CONTENT_FILE];
      await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

      sinon.assert.notCalled(listener);
    });

    it('does not emit when a watched directory is unchanged', async () => {
      const { rootContents } = stubWatchedRootDirectory();
      rootContents.content = [FOO_CONTENT_FILE];

      fs.watch(TestUri.parse('colab://m-s-foo/'), {
        recursive: false,
        excludes: [],
      });
      await flushWatchRun();
      listener.resetHistory();

      await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

      sinon.assert.notCalled(listener);
    });

    it('emits created and deleted events for direct child changes', async () => {
      const { rootContents } = stubWatchedRootDirectory();

      fs.watch(TestUri.parse('colab://m-s-foo/'), {
        recursive: false,
        excludes: [],
      });
      await flushWatchRun();
      listener.resetHistory();

      rootContents.content = [FOO_CONTENT_FILE];
      await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

      sinon.assert.calledOnceWithMatch(listener, [
        {
          type: FileChangeType.Created,
          uri: uriStringMatch('colab://m-s-foo/foo.txt'),
        },
      ]);

      listener.resetHistory();
      rootContents.content = [];
      await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

      sinon.assert.calledOnceWithMatch(listener, [
        {
          type: FileChangeType.Deleted,
          uri: uriStringMatch('colab://m-s-foo/foo.txt'),
        },
      ]);
    });

    it('emits recursive events for nested directory changes', async () => {
      const { rootContents, fooContents } = stubWatchedRootDirectory();
      rootContents.content = [FOO_CONTENT_DIR];
      const nestedFile: Contents = {
        ...FOO_CONTENT_FILE,
        path: '/foo/foo.txt',
      };

      fs.watch(TestUri.parse('colab://m-s-foo/'), {
        recursive: true,
        excludes: [],
      });
      await flushWatchRun();
      listener.resetHistory();

      fooContents.content = [nestedFile];
      await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

      sinon.assert.calledOnceWithMatch(listener, [
        {
          type: FileChangeType.Created,
          uri: uriStringMatch('colab://m-s-foo/foo/foo.txt'),
        },
      ]);
    });

    it('stops polling when the returned disposable is disposed', async () => {
      const { contentsStub } = stubWatchedRootDirectory();
      const watch = fs.watch(TestUri.parse('colab://m-s-foo/'), {
        recursive: false,
        excludes: [],
      });
      await flushWatchRun();
      contentsStub.get.resetHistory();

      watch.dispose();
      await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

      sinon.assert.notCalled(contentsStub.get);
    });

    describe('file watch', () => {
      function stubWatchedFile(
        endpoint: string,
        path: string,
        initial: Contents,
      ): {
        contentsStub: sinon.SinonStubbedInstance<ContentsApi>;
        metadata: Contents;
      } {
        const contentsStub = stubClient(endpoint);
        const metadata = { ...initial };
        contentsStub.get.callsFake((request) => {
          if (request.path === path && request.content === 0) {
            return Promise.resolve({ ...metadata });
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });
        return { contentsStub, metadata };
      }

      it('emits changed when mtime advances', async () => {
        const { metadata } = stubWatchedFile(
          'm-s-foo',
          '/foo.txt',
          FOO_CONTENT_FILE,
        );

        fs.watch(TestUri.parse('colab://m-s-foo/foo.txt'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        metadata.lastModified = '2026-01-01T00:00:00Z';
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Changed,
            uri: uriStringMatch('colab://m-s-foo/foo.txt'),
          },
        ]);
      });

      it('emits a single changed event when both mtime and size change', async () => {
        const { metadata } = stubWatchedFile(
          'm-s-foo',
          '/foo.txt',
          FOO_CONTENT_FILE,
        );

        fs.watch(TestUri.parse('colab://m-s-foo/foo.txt'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        metadata.lastModified = '2026-01-01T00:00:00Z';
        metadata.size = 99;
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnce(listener);
        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Changed,
            uri: uriStringMatch('colab://m-s-foo/foo.txt'),
          },
        ]);
      });

      it('emits changed when size changes', async () => {
        const { metadata } = stubWatchedFile(
          'm-s-foo',
          '/foo.txt',
          FOO_CONTENT_FILE,
        );

        fs.watch(TestUri.parse('colab://m-s-foo/foo.txt'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        metadata.size = 42;
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Changed,
            uri: uriStringMatch('colab://m-s-foo/foo.txt'),
          },
        ]);
      });

      it('does not emit when file metadata is unchanged', async () => {
        stubWatchedFile('m-s-foo', '/foo.txt', FOO_CONTENT_FILE);

        fs.watch(TestUri.parse('colab://m-s-foo/foo.txt'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.notCalled(listener);
      });
    });

    describe('resource presence transitions', () => {
      it('emits deleted when a watched file disappears', async () => {
        const contentsStub = stubClient('m-s-foo');
        contentsStub.get.callsFake((request) => {
          if (request.path === '/foo.txt' && request.content === 0) {
            return Promise.resolve(FOO_CONTENT_FILE);
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });

        fs.watch(TestUri.parse('colab://m-s-foo/foo.txt'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        contentsStub.get.callsFake((request) => {
          if (request.path === '/foo.txt' && request.content === 0) {
            return Promise.reject(NOT_FOUND);
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Deleted,
            uri: uriStringMatch('colab://m-s-foo/foo.txt'),
          },
        ]);
      });

      it('emits created when a previously absent resource appears', async () => {
        const contentsStub = stubClient('m-s-foo');
        contentsStub.get.callsFake((request) => {
          if (request.path === '/foo.txt' && request.content === 0) {
            return Promise.reject(NOT_FOUND);
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });

        fs.watch(TestUri.parse('colab://m-s-foo/foo.txt'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        contentsStub.get.callsFake((request) => {
          if (request.path === '/foo.txt' && request.content === 0) {
            return Promise.resolve(FOO_CONTENT_FILE);
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Created,
            uri: uriStringMatch('colab://m-s-foo/foo.txt'),
          },
        ]);
      });

      it('does not emit when a resource remains absent', async () => {
        const contentsStub = stubClient('m-s-foo');
        contentsStub.get.callsFake((request) => {
          if (request.path === '/foo.txt' && request.content === 0) {
            return Promise.reject(NOT_FOUND);
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });

        fs.watch(TestUri.parse('colab://m-s-foo/foo.txt'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.notCalled(listener);
      });
    });

    describe('kind transitions', () => {
      it('emits delete and create when a file becomes a directory', async () => {
        const contentsStub = stubClient('m-s-foo');
        contentsStub.get.callsFake((request) => {
          if (request.path === '/foo' && request.content === 0) {
            return Promise.resolve(FOO_CONTENT_FILE);
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });

        fs.watch(TestUri.parse('colab://m-s-foo/foo'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        const fooAsDir: DirectoryContents = {
          ...FOO_CONTENT_DIR,
          type: 'directory',
          content: [],
        };
        contentsStub.get.callsFake((request) => {
          if (request.path === '/foo' && request.content === 0) {
            return Promise.resolve(FOO_CONTENT_DIR);
          }
          if (
            request.path === '/foo' &&
            request.type === ContentsGetTypeEnum.Directory
          ) {
            return Promise.resolve(fooAsDir);
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Deleted,
            uri: uriStringMatch('colab://m-s-foo/foo'),
          },
          {
            type: FileChangeType.Created,
            uri: uriStringMatch('colab://m-s-foo/foo'),
          },
        ]);
      });

      it('emits delete and create when a directory becomes a file', async () => {
        const contentsStub = stubClient('m-s-foo');
        const fooAsDir: DirectoryContents = {
          ...FOO_CONTENT_DIR,
          type: 'directory',
          content: [],
        };
        contentsStub.get.callsFake((request) => {
          if (request.path === '/foo' && request.content === 0) {
            return Promise.resolve(FOO_CONTENT_DIR);
          }
          if (
            request.path === '/foo' &&
            request.type === ContentsGetTypeEnum.Directory
          ) {
            return Promise.resolve(fooAsDir);
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });

        fs.watch(TestUri.parse('colab://m-s-foo/foo'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        contentsStub.get.callsFake((request) => {
          if (request.path === '/foo' && request.content === 0) {
            return Promise.resolve({
              ...FOO_CONTENT_FILE,
              name: 'foo',
              path: '/foo',
            });
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Deleted,
            uri: uriStringMatch('colab://m-s-foo/foo'),
          },
          {
            type: FileChangeType.Created,
            uri: uriStringMatch('colab://m-s-foo/foo'),
          },
        ]);
      });
    });

    describe('reference counting', () => {
      it('continues polling when one of multiple watchers disposes', async () => {
        const { contentsStub } = stubWatchedRootDirectory();
        const watch1 = fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        // Second watch increments refCount; we don't need the disposable.
        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        contentsStub.get.resetHistory();

        watch1.dispose();
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.called(contentsStub.get);
      });

      it('stops polling only when all watchers for a URI dispose', async () => {
        const { contentsStub } = stubWatchedRootDirectory();
        const watch1 = fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        const watch2 = fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        contentsStub.get.resetHistory();

        watch1.dispose();
        watch2.dispose();
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.notCalled(contentsStub.get);
      });

      it('treats recursive and non-recursive watches as separate registrations', async () => {
        const { contentsStub } = stubWatchedRootDirectory();
        const watchDirect = fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        const watchRecursive = fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: true,
          excludes: [],
        });
        await flushWatchRun();
        contentsStub.get.resetHistory();

        watchDirect.dispose();
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        // The recursive watch is still active, so polling continues.
        sinon.assert.called(contentsStub.get);

        contentsStub.get.resetHistory();
        watchRecursive.dispose();
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.notCalled(contentsStub.get);
      });

      it('resumes polling when a new watch is registered after all prior watchers disposed', async () => {
        const { contentsStub, rootContents } = stubWatchedRootDirectory();
        const watch1 = fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();

        watch1.dispose();
        contentsStub.get.resetHistory();
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);
        // Polling should have stopped.
        sinon.assert.notCalled(contentsStub.get);

        // Re-register a fresh watch on the same URI.
        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        rootContents.content = [FOO_CONTENT_FILE];
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Created,
            uri: uriStringMatch('colab://m-s-foo/foo.txt'),
          },
        ]);
      });

      it('no-ops when disposing an already-removed watch', async () => {
        stubWatchedRootDirectory();
        const watch = fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();

        watch.dispose();
        // Second dispose should not throw.

        expect(() => {
          watch.dispose();
        }).to.not.throw();
      });
    });

    describe('covered roots deduplication', () => {
      it('skips a non-recursive child watch already covered by a recursive parent', async () => {
        const contentsStub = stubClient('m-s-foo');
        const rootContents: DirectoryContents = {
          ...ROOT_CONTENT_DIR,
          type: 'directory',
          content: [FOO_CONTENT_DIR],
        };
        const fooContents: DirectoryContents = {
          ...FOO_CONTENT_DIR,
          type: 'directory',
          content: [],
        };
        contentsStub.get.callsFake((request) => {
          if (request.path === '/' && request.content === 0) {
            return Promise.resolve(ROOT_CONTENT_DIR);
          }
          if (
            request.path === '/' &&
            request.type === ContentsGetTypeEnum.Directory
          ) {
            return Promise.resolve(rootContents);
          }
          if (request.path === '/foo' && request.content === 0) {
            return Promise.resolve(FOO_CONTENT_DIR);
          }
          if (
            request.path === '/foo' &&
            request.type === ContentsGetTypeEnum.Directory
          ) {
            return Promise.resolve(fooContents);
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });

        // Register recursive parent first, then non-recursive child.
        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: true,
          excludes: [],
        });
        fs.watch(TestUri.parse('colab://m-s-foo/foo'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        // Add a file in /foo. Only the recursive parent should detect and
        // report it — the child watch should be skipped as covered.
        const nestedFile: Contents = {
          ...FOO_CONTENT_FILE,
          path: '/foo/bar.txt',
          name: 'bar.txt',
        };
        fooContents.content = [nestedFile];
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        // Exactly one event batch (not duplicated from the child watch).
        sinon.assert.calledOnce(listener);
      });
    });

    describe('error isolation', () => {
      it('continues polling other watches when one watch errors', async () => {
        const contentsStub = stubClient('m-s-foo');
        const rootContents: DirectoryContents = {
          ...ROOT_CONTENT_DIR,
          type: 'directory',
          content: [],
        };
        contentsStub.get.callsFake((request) => {
          if (request.path === '/' && request.content === 0) {
            return Promise.resolve(ROOT_CONTENT_DIR);
          }
          if (
            request.path === '/' &&
            request.type === ContentsGetTypeEnum.Directory
          ) {
            return Promise.resolve(rootContents);
          }
          if (request.path === '/broken' && request.content === 0) {
            return Promise.reject(new Error('network failure'));
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });

        // The broken watch will fail on every poll but should not prevent
        // the root watch from detecting changes.
        fs.watch(TestUri.parse('colab://m-s-foo/broken'), {
          recursive: false,
          excludes: [],
        });
        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        // Flush the initial poll and a second interval to ensure both
        // watches have been initialized (the first start+runNow may only
        // yield one poll cycle due to AllowToComplete).
        await flushWatchRun();
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);
        listener.resetHistory();

        rootContents.content = [FOO_CONTENT_FILE];
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Created,
            uri: uriStringMatch('colab://m-s-foo/foo.txt'),
          },
        ]);
      });

      it('does not let a failing recursive parent suppress child watches', async () => {
        const contentsStub = stubClient('m-s-foo');
        const fooContents: DirectoryContents = {
          ...FOO_CONTENT_DIR,
          type: 'directory',
          content: [],
        };
        contentsStub.get.callsFake((request) => {
          if (request.path === '/' && request.content === 0) {
            return Promise.resolve(ROOT_CONTENT_DIR);
          }
          if (
            request.path === '/' &&
            request.type === ContentsGetTypeEnum.Directory
          ) {
            return Promise.reject(new Error('root snapshot failed'));
          }
          if (request.path === '/foo' && request.content === 0) {
            return Promise.resolve(FOO_CONTENT_DIR);
          }
          if (
            request.path === '/foo' &&
            request.type === ContentsGetTypeEnum.Directory
          ) {
            return Promise.resolve(fooContents);
          }
          return Promise.reject(
            new Error(
              `Unexpected contents.get request: ${JSON.stringify(request)}`,
            ),
          );
        });

        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: true,
          excludes: [],
        });
        fs.watch(TestUri.parse('colab://m-s-foo/foo'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);
        listener.resetHistory();

        fooContents.content = [
          {
            ...FOO_CONTENT_FILE,
            name: 'bar.txt',
            path: '/foo/bar.txt',
          },
        ];
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Created,
            uri: uriStringMatch('colab://m-s-foo/foo/bar.txt'),
          },
        ]);
      });
    });

    describe('directory child metadata change', () => {
      it('emits changed when a child file mtime advances within a watched directory', async () => {
        const { rootContents } = stubWatchedRootDirectory();
        rootContents.content = [FOO_CONTENT_FILE];

        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        rootContents.content = [
          { ...FOO_CONTENT_FILE, lastModified: '2026-01-01T00:00:00Z' },
        ];
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Changed,
            uri: uriStringMatch('colab://m-s-foo/foo.txt'),
          },
        ]);
      });

      it('emits changed when a child file size changes within a watched directory', async () => {
        const { rootContents } = stubWatchedRootDirectory();
        rootContents.content = [FOO_CONTENT_FILE];

        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        rootContents.content = [{ ...FOO_CONTENT_FILE, size: 1024 }];
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Changed,
            uri: uriStringMatch('colab://m-s-foo/foo.txt'),
          },
        ]);
      });

      it('does not emit when a child file metadata is unchanged', async () => {
        const { rootContents } = stubWatchedRootDirectory();
        rootContents.content = [FOO_CONTENT_FILE];

        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.notCalled(listener);
      });

      it('emits changed for a nested file modification in a recursive watch', async () => {
        const { rootContents, fooContents } = stubWatchedRootDirectory();
        rootContents.content = [FOO_CONTENT_DIR];
        const nestedFile: Contents = {
          ...FOO_CONTENT_FILE,
          path: '/foo/foo.txt',
        };
        fooContents.content = [nestedFile];

        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: true,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        fooContents.content = [
          { ...nestedFile, lastModified: '2026-06-01T00:00:00Z', size: 999 },
        ];
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Changed,
            uri: uriStringMatch('colab://m-s-foo/foo/foo.txt'),
          },
        ]);
      });
    });

    describe('directory child type change', () => {
      it('emits delete and create when a child changes from file to directory', async () => {
        const { rootContents } = stubWatchedRootDirectory();
        rootContents.content = [FOO_CONTENT_FILE];

        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: false,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        // Replace the file entry with a directory of the same name.
        rootContents.content = [
          { ...FOO_CONTENT_FILE, type: 'directory' } as Contents,
        ];
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        sinon.assert.calledOnceWithMatch(listener, [
          {
            type: FileChangeType.Deleted,
            uri: uriStringMatch('colab://m-s-foo/foo.txt'),
          },
          {
            type: FileChangeType.Created,
            uri: uriStringMatch('colab://m-s-foo/foo.txt'),
          },
        ]);
      });
    });

    describe('collapse nested entries', () => {
      it('collapses child events under a deleted parent directory', async () => {
        const { rootContents, fooContents } = stubWatchedRootDirectory();
        const nestedFile: Contents = {
          ...FOO_CONTENT_FILE,
          path: '/foo/bar.txt',
          name: 'bar.txt',
        };
        rootContents.content = [FOO_CONTENT_DIR];
        fooContents.content = [nestedFile];

        fs.watch(TestUri.parse('colab://m-s-foo/'), {
          recursive: true,
          excludes: [],
        });
        await flushWatchRun();
        listener.resetHistory();

        // Remove the entire /foo directory (including its child).
        rootContents.content = [];
        fooContents.content = [];
        await fakeClock.tickAsync(WATCH_POLL_INTERVAL_MS);

        // Should emit a single Deleted event for /foo, not separate events
        // for both /foo and /foo/bar.txt.
        sinon.assert.calledOnce(listener);
        const events: FileChangeEvent[] = listener.firstCall.args[0];
        const deletedUris = events
          .filter((e) => e.type === vs.FileChangeType.Deleted)
          .map((e) => e.uri.toString());
        expect(deletedUris).to.include('colab://m-s-foo/foo');
        expect(deletedUris).to.not.include('colab://m-s-foo/foo/bar.txt');
      });
    });
  });

  describe('stat', () => {
    it('throws when disposed', async () => {
      fs.dispose();

      await expect(
        fs.stat(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/disposed/);
    });

    it('throws file system not found errors for VS Code files', async () => {
      await expect(
        fs.stat(TestUri.parse('colab://m-s-foo/.vscode')),
      ).to.eventually.rejectedWith(/FileNotFound/);
    });

    it('returns file stat', async () => {
      const contentsStub = stubClient('m-s-foo');
      const contents = CONTENT_DIR.withoutContents;
      contentsStub.get.withArgs({ path: '/', content: 0 }).resolves(contents);

      await expect(
        fs.stat(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.deep.equal({
        type: FileType.Directory,
        ctime: new Date(contents.created).getTime(),
        mtime: new Date(contents.lastModified).getTime(),
        size: 0,
      });
    });

    it('throws file system no permissions error on content forbidden responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(FORBIDDEN);

      await expect(
        fs.stat(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/NoPermissions/);
    });

    it('throws file system file not found error on content not found responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(NOT_FOUND);

      await expect(
        fs.stat(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/FileNotFound/);
    });

    it('throws file system file exists error on content conflict responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(CONFLICT);

      await expect(
        fs.stat(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/FileExists/);
    });

    it('throws unhandled content response errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(TEAPOT);

      await expect(
        fs.stat(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(TEAPOT.message);
    });

    it('throws unhandled errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(new Error('🤮'));

      await expect(
        fs.stat(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith('🤮');
    });
  });

  describe('readDirectory', () => {
    it('throws when disposed', async () => {
      fs.dispose();

      await expect(
        fs.readDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/disposed/);
    });

    it('throws file system not found errors for VS Code files', async () => {
      await expect(
        fs.readDirectory(TestUri.parse('colab://m-s-foo/.vscode')),
      ).to.eventually.rejectedWith(/FileNotFound/);
    });

    it('throws file system file not a directory errors for non-directory URIs', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get
        .withArgs({ path: '/foo.txt', type: 'directory' })
        .resolves(FOO_CONTENT_FILE);

      await expect(
        fs.readDirectory(TestUri.parse('colab://m-s-foo/foo.txt')),
      ).to.eventually.rejectedWith(/FileNotADirectory/);
    });

    it("returns the directory's children file types", async () => {
      const contentsStub = stubClient('m-s-foo');
      const contents = CONTENT_DIR.withContents;
      contentsStub.get
        .withArgs({ path: '/', type: 'directory' })
        .resolves(contents);

      await expect(
        fs.readDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.deep.equal([[contents.content[0].name, FileType.File]]);
    });

    it('throws file system no permissions error on content forbidden responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(FORBIDDEN);

      await expect(
        fs.readDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/NoPermissions/);
    });

    it('throws file system file not found error on content not found responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(NOT_FOUND);

      await expect(
        fs.readDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/FileNotFound/);
    });

    it('throws file system file exists error on content conflict responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(CONFLICT);

      await expect(
        fs.readDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/FileExists/);
    });

    it('throws unhandled content response errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(TEAPOT);

      await expect(
        fs.readDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(TEAPOT.message);
    });

    it('throws unhandled errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(new Error('🤮'));

      await expect(
        fs.readDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith('🤮');
    });
  });

  describe('createDirectory', () => {
    it('throws when disposed', async () => {
      fs.dispose();

      await expect(
        fs.createDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/disposed/);
    });

    it('throws file system not found errors for VS Code files', async () => {
      await expect(
        fs.createDirectory(TestUri.parse('colab://m-s-foo/.vscode')),
      ).to.eventually.rejectedWith(/FileNotFound/);
    });

    it('saves the directory to contents when created', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.save.resolves(FOO_CONTENT_DIR);

      await fs.createDirectory(TestUri.parse('colab://m-s-foo/foo'));

      sinon.assert.calledWithMatch(contentsStub.save, {
        path: '/foo',
        model: {
          type: ContentsGetTypeEnum.Directory,
        },
      });
    });

    it('fires onDidChangeFile when created', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.save.resolves(FOO_CONTENT_DIR);

      await fs.createDirectory(TestUri.parse('colab://m-s-foo/foo'));

      sinon.assert.calledWith(listener, [
        {
          type: FileChangeType.Created,
          uri: uriStringMatch('colab://m-s-foo/foo'),
        },
      ]);
    });

    it('throws file system no permissions error on content forbidden responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.save.rejects(FORBIDDEN);

      await expect(
        fs.createDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/NoPermissions/);
    });

    it('throws file system file not found error on content not found responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.save.rejects(NOT_FOUND);

      await expect(
        fs.createDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/FileNotFound/);
    });

    it('throws file system file exists error on content conflict responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.save.rejects(CONFLICT);

      await expect(
        fs.createDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(/FileExists/);
    });

    it('throws unhandled content response errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.save.rejects(TEAPOT);

      await expect(
        fs.createDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith(TEAPOT.message);
    });

    it('throws unhandled errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.save.rejects(new Error('🤮'));

      await expect(
        fs.createDirectory(TestUri.parse('colab://m-s-foo/')),
      ).to.eventually.rejectedWith('🤮');
    });
  });

  describe('readFile', () => {
    it('throws when disposed', async () => {
      fs.dispose();

      await expect(
        fs.readFile(TestUri.parse('colab://m-s-foo/foo.txt')),
      ).to.eventually.rejectedWith(/disposed/);
    });

    it('throws file system not found errors for VS Code files', async () => {
      await expect(
        fs.readFile(TestUri.parse('colab://m-s-foo/.vscode/settings.json')),
      ).to.eventually.rejectedWith(/FileNotFound/);
    });

    it('throws when the contents are not a string', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get
        .withArgs({ path: '/foo.txt', format: 'base64', type: 'file' })
        .resolves({ ...FOO_CONTENT_FILE, content: [] });

      await expect(
        fs.readFile(TestUri.parse('colab://m-s-foo/foo.txt')),
      ).to.eventually.rejectedWith(/Unexpected content format/);
    });

    it('returns a buffer for a file with empty content', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.resolves(CONTENT_DIR.withoutContents);

      const result = await fs.readFile(TestUri.parse('colab://m-s-foo/'));

      expect(result).to.deep.equal(Buffer.from(''));
    });

    it('returns a buffer of the base64 encoded contents for a file', async () => {
      const contentsStub = stubClient('m-s-foo');
      const content = 'hello world';
      const encoded = Buffer.from(content).toString('base64');
      contentsStub.get
        .withArgs({ path: '/foo.txt', format: 'base64', type: 'file' })
        .resolves({
          ...FOO_CONTENT_FILE,
          format: 'base64',
          content: encoded,
        });

      const result = await fs.readFile(
        TestUri.parse('colab://m-s-foo/foo.txt'),
      );

      expect(result).to.deep.equal(Buffer.from(content));
    });

    it('throws file system no permissions error on content forbidden responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(FORBIDDEN);

      await expect(
        fs.readFile(TestUri.parse('colab://m-s-foo/foo.txt')),
      ).to.eventually.rejectedWith(/NoPermissions/);
    });

    it('throws file system file not found error on content not found responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(NOT_FOUND);

      await expect(
        fs.readFile(TestUri.parse('colab://m-s-foo/foo.txt')),
      ).to.eventually.rejectedWith(/FileNotFound/);
    });

    it('throws file system file exists error on content conflict responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(CONFLICT);

      await expect(
        fs.readFile(TestUri.parse('colab://m-s-foo/foo.txt')),
      ).to.eventually.rejectedWith(/FileExists/);
    });

    it('throws unhandled content response errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(TEAPOT);

      await expect(
        fs.readFile(TestUri.parse('colab://m-s-foo/foo.txt')),
      ).to.eventually.rejectedWith(TEAPOT.message);
    });

    it('throws unhandled errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(new Error('🤮'));

      await expect(
        fs.readFile(TestUri.parse('colab://m-s-foo/foo.txt')),
      ).to.eventually.rejectedWith('🤮');
    });
  });

  describe('writeFile', () => {
    it('throws when disposed', async () => {
      fs.dispose();

      await expect(
        fs.writeFile(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          Buffer.from(''),
          {
            create: true,
            overwrite: true,
          },
        ),
      ).to.eventually.rejectedWith(/disposed/);
    });

    const existenceChecks: [
      'create' | 'overwrite' | 'create and overwrite' | 'none',
      'file exists' | 'file does not exist',
      'changed' | 'created' | 'no event',
      'throws exists' | 'throws not found' | 'saves',
    ][] = [
      // File exists.
      ['none', 'file exists', 'no event', 'throws exists'],
      ['create', 'file exists', 'no event', 'throws exists'],
      ['overwrite', 'file exists', 'changed', 'saves'],
      ['create and overwrite', 'file exists', 'changed', 'saves'],
      // File doesn't exist.
      ['none', 'file does not exist', 'no event', 'throws not found'],
      ['create', 'file does not exist', 'created', 'saves'],
      ['overwrite', 'file does not exist', 'no event', 'throws not found'],
      ['create and overwrite', 'file does not exist', 'created', 'saves'],
    ];
    for (const t of existenceChecks) {
      const [options, existence, event, outcome] = t;
      const opts = {
        create: options.includes('create'),
        overwrite: options.includes('overwrite'),
      };
      describe(`with options set to ${options} when the ${existence}`, () => {
        let contentsStub: sinon.SinonStubbedInstance<ContentsApi>;

        beforeEach(() => {
          contentsStub = stubClient('m-s-foo');
          if (existence === 'file exists') {
            contentsStub.get.resolves(FOO_CONTENT_FILE);
          } else {
            contentsStub.get.rejects(NOT_FOUND);
          }
        });

        it(outcome, async () => {
          const call = fs.writeFile(
            TestUri.parse('colab://m-s-foo/foo.txt'),
            Buffer.from('hello'),
            opts,
          );

          if (outcome === 'throws exists') {
            await expect(call).to.eventually.rejectedWith(/FileExists/);
          } else if (outcome === 'throws not found') {
            await expect(call).to.eventually.rejectedWith(/FileNotFound/);
          } else {
            await call;
            sinon.assert.calledWithMatch(contentsStub.save, {
              path: '/foo.txt',
              model: {
                type: ContentsGetTypeEnum.File,
                format: 'base64',
                content: Buffer.from('hello').toString('base64'),
              },
            });
          }
        });

        it(`emits ${event} `, async () => {
          const call = fs.writeFile(
            TestUri.parse('colab://m-s-foo/foo.txt'),
            Buffer.from('hello'),
            opts,
          );

          try {
            await call;
          } catch {
            // Outcome not important for this test.
          }

          if (event === 'no event') {
            sinon.assert.notCalled(listener);
          } else {
            sinon.assert.calledWith(listener, [
              {
                type:
                  event === 'created'
                    ? FileChangeType.Created
                    : FileChangeType.Changed,
                uri: uriStringMatch('colab://m-s-foo/foo.txt'),
              },
            ]);
          }
        });
      });
    }

    it('throws file system no permissions error on content forbidden responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(FORBIDDEN);

      await expect(
        fs.writeFile(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          Buffer.from(''),
          { create: false, overwrite: false },
        ),
      ).to.eventually.rejectedWith(/NoPermissions/);
    });

    it('throws file system file not found error on content not found responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.save.rejects(NOT_FOUND);

      await expect(
        fs.writeFile(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          Buffer.from(''),
          { create: true, overwrite: true },
        ),
      ).to.eventually.rejectedWith(/FileNotFound/);
    });

    it('throws file system file exists error on content conflict responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.save.rejects(CONFLICT);

      await expect(
        fs.writeFile(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          Buffer.from(''),
          { create: true, overwrite: true },
        ),
      ).to.eventually.rejectedWith(/FileExists/);
    });

    it('throws unhandled content response errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.save.rejects(TEAPOT);

      await expect(
        fs.writeFile(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          Buffer.from(''),
          { create: true, overwrite: true },
        ),
      ).to.eventually.rejectedWith(TEAPOT.message);
    });

    it('throws unhandled errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.save.rejects(new Error('🤮'));

      await expect(
        fs.writeFile(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          Buffer.from(''),
          { create: true, overwrite: true },
        ),
      ).to.eventually.rejectedWith('🤮');
    });
  });

  describe('delete', () => {
    it('throws when disposed', async () => {
      fs.dispose();

      await expect(
        fs.delete(TestUri.parse('colab://m-s-foo/foo.txt'), {
          recursive: false,
        }),
      ).to.eventually.rejectedWith(/disposed/);
    });

    describe('directory with files', () => {
      let contentsStub: sinon.SinonStubbedInstance<ContentsApi>;

      beforeEach(() => {
        contentsStub = stubClient('m-s-foo');
        // stat calls
        contentsStub.get
          .withArgs({ path: '/foo', content: 0 })
          .resolves(CONTENT_DIR.withoutContents);
        contentsStub.get
          .withArgs({ path: '/foo/foo.txt', content: 0 })
          .resolves(FOO_CONTENT_FILE);
        // readDirectory call
        contentsStub.get
          .withArgs({ path: '/foo', type: 'directory' })
          .resolves(CONTENT_DIR.withContents);
      });

      it('throws file system no permissions for non-recursive deletes', async () => {
        await expect(
          fs.delete(TestUri.parse('colab://m-s-foo/foo'), { recursive: false }),
        ).to.eventually.rejectedWith(/NoPermissions/);
      });

      it('recursively deletes directory', async () => {
        await fs.delete(TestUri.parse('colab://m-s-foo/foo'), {
          recursive: true,
        });

        sinon.assert.calledWith(contentsStub.delete, { path: '/foo/foo.txt' });
        sinon.assert.calledWith(contentsStub.delete, { path: '/foo' });
      });
    });

    describe('file', () => {
      let contentsStub: sinon.SinonStubbedInstance<ContentsApi>;

      beforeEach(() => {
        contentsStub = stubClient('m-s-foo');
        contentsStub.get
          .withArgs({ path: '/foo.txt', content: 0 })
          .resolves(FOO_CONTENT_FILE);
      });

      for (const recursive of [true, false]) {
        describe(`with recursive ${String(recursive)}`, () => {
          it('deletes the file', async () => {
            await fs.delete(TestUri.parse('colab://m-s-foo/foo.txt'), {
              recursive,
            });

            sinon.assert.calledWith(contentsStub.delete, { path: '/foo.txt' });
          });

          it('throws file system no permissions error on content forbidden responses', async () => {
            contentsStub.delete.rejects(FORBIDDEN);

            await expect(
              fs.delete(TestUri.parse('colab://m-s-foo/foo.txt'), {
                recursive,
              }),
            ).to.eventually.rejectedWith(/NoPermissions/);
          });

          it('throws file system file not found error on content not found responses', async () => {
            contentsStub.delete.rejects(NOT_FOUND);

            await expect(
              fs.delete(TestUri.parse('colab://m-s-foo/foo.txt'), {
                recursive,
              }),
            ).to.eventually.rejectedWith(/FileNotFound/);
          });

          it('throws file system file exists error on content conflict responses', async () => {
            contentsStub.delete.rejects(CONFLICT);

            await expect(
              fs.delete(TestUri.parse('colab://m-s-foo/foo.txt'), {
                recursive,
              }),
            ).to.eventually.rejectedWith(/FileExists/);
          });

          it('throws unhandled content response errors', async () => {
            contentsStub.delete.rejects(TEAPOT);

            await expect(
              fs.delete(TestUri.parse('colab://m-s-foo/foo.txt'), {
                recursive,
              }),
            ).to.eventually.rejectedWith(TEAPOT.message);
          });

          it('throws unhandled errors', async () => {
            contentsStub.delete.rejects(new Error('🤮'));

            await expect(
              fs.delete(TestUri.parse('colab://m-s-foo/foo.txt'), {
                recursive,
              }),
            ).to.eventually.rejectedWith('🤮');
          });
        });
      }
    });
  });

  describe('rename', () => {
    it('throws when disposed', async () => {
      fs.dispose();

      await expect(
        fs.rename(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          TestUri.parse('colab://m-s-foo/bar.txt'),
          { overwrite: false },
        ),
      ).to.eventually.rejectedWith(/disposed/);
    });

    it('throws on cross-server renames', async () => {
      await expect(
        fs.rename(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          TestUri.parse('colab://m-s-bar/bar.txt'),
          { overwrite: false },
        ),
      ).to.eventually.rejectedWith(/not supported/);
    });

    it('throws file system file exists error if new URI already exists', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.resolves({
        name: 'bar.txt',
        path: '/bar.txt',
        type: 'file',
        writable: true,
        created: '2025-12-16T14:30:53.932129Z',
        lastModified: '2025-12-11T14:34:40Z',
        size: 0,
        mimetype: 'text/plain',
        content: '',
        format: 'text',
      });

      await expect(
        fs.rename(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          TestUri.parse('colab://m-s-foo/bar.txt'),
          { overwrite: false },
        ),
      ).to.eventually.rejectedWith(/FileExists/);
    });

    it('renames file', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.rejects(NOT_FOUND);

      await fs.rename(
        TestUri.parse('colab://m-s-foo/foo.txt'),
        TestUri.parse('colab://m-s-foo/bar.txt'),
        { overwrite: false },
      );

      sinon.assert.calledWith(contentsStub.rename, {
        path: '/foo.txt',
        rename: { path: '/bar.txt' },
      });
    });

    it('renames existing file when configured to overwrite', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.get.withArgs({ path: '/bar.txt', content: 0 }).resolves({
        name: 'bar.txt',
        path: '/bar.txt',
        type: 'file',
        writable: true,
        created: '2025-12-16T14:30:53.932129Z',
        lastModified: '2025-12-11T14:34:40Z',
        size: 0,
        mimetype: 'text/plain',
        content: '',
        format: 'text',
      });

      await fs.rename(
        TestUri.parse('colab://m-s-foo/foo.txt'),
        TestUri.parse('colab://m-s-foo/bar.txt'),
        { overwrite: true },
      );

      sinon.assert.calledWith(contentsStub.rename, {
        path: '/foo.txt',
        rename: { path: '/bar.txt' },
      });
    });

    it('throws file system no permissions error on content forbidden responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.rename.rejects(FORBIDDEN);

      await expect(
        fs.rename(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          TestUri.parse('colab://m-s-foo/bar.txt'),
          { overwrite: true },
        ),
      ).to.eventually.rejectedWith(/NoPermissions/);
    });

    it('throws file system file not found error on content not found responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.rename.rejects(NOT_FOUND);

      await expect(
        fs.rename(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          TestUri.parse('colab://m-s-foo/bar.txt'),
          { overwrite: true },
        ),
      ).to.eventually.rejectedWith(/FileNotFound/);
    });

    it('throws file system file exists error on content conflict responses', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.rename.rejects(CONFLICT);

      await expect(
        fs.rename(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          TestUri.parse('colab://m-s-foo/bar.txt'),
          { overwrite: true },
        ),
      ).to.eventually.rejectedWith(/FileExists/);
    });

    it('throws unhandled content response errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.rename.rejects(TEAPOT);

      await expect(
        fs.rename(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          TestUri.parse('colab://m-s-foo/bar.txt'),
          { overwrite: true },
        ),
      ).to.eventually.rejectedWith(TEAPOT.message);
    });

    it('throws unhandled errors', async () => {
      const contentsStub = stubClient('m-s-foo');
      contentsStub.rename.rejects(new Error('🤮'));

      await expect(
        fs.rename(
          TestUri.parse('colab://m-s-foo/foo.txt'),
          TestUri.parse('colab://m-s-foo/bar.txt'),
          { overwrite: true },
        ),
      ).to.eventually.rejectedWith('🤮');
    });
  });
});

function uriStringMatch(s: string): sinon.SinonMatcher {
  return sinon.match((u: Uri) => {
    return u.toString() === s;
  });
}

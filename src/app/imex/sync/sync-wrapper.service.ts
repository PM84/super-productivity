import { inject, Injectable } from '@angular/core';
import { Observable, of, Subject } from 'rxjs';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { filter, first, map, switchMap, take } from 'rxjs/operators';
import { SyncConfig } from '../../features/config/global-config.model';
import { TranslateService } from '@ngx-translate/core';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { SnackService } from '../../core/snack/snack.service';
import {
  AuthFailSPError,
  CanNotMigrateMajorDownError,
  ConflictData,
  DecryptError,
  DecryptNoPasswordError,
  LockPresentError,
  NoRemoteModelFile,
  RevMismatchForModelError,
  SyncInvalidTimeValuesError,
  SyncProviderId,
  SyncStatus,
} from '../../pfapi/api';
import { PfapiService } from '../../pfapi/pfapi.service';
import { T } from '../../t.const';
import { getSyncErrorStr } from './get-sync-error-str';
import { DialogGetAndEnterAuthCodeComponent } from './dialog-get-and-enter-auth-code/dialog-get-and-enter-auth-code.component';
import { DialogConflictResolutionResult } from './sync.model';
import { DialogSyncConflictComponent } from './dialog-sync-conflict/dialog-sync-conflict.component';
import { ReminderService } from '../../features/reminder/reminder.service';
import { DataInitService } from '../../core/data-init/data-init.service';
import { DialogSyncInitialCfgComponent } from './dialog-sync-initial-cfg/dialog-sync-initial-cfg.component';
import { DialogIncompleteSyncComponent } from './dialog-incomplete-sync/dialog-incomplete-sync.component';
import { DialogHandleDecryptErrorComponent } from './dialog-handle-decrypt-error/dialog-handle-decrypt-error.component';
import { DialogIncoherentTimestampsErrorComponent } from './dialog-incoherent-timestamps-error/dialog-incoherent-timestamps-error.component';

@Injectable({
  providedIn: 'root',
})
export class SyncWrapperService {
  private _pfapiService = inject(PfapiService);
  private _globalConfigService = inject(GlobalConfigService);
  private _translateService = inject(TranslateService);
  private _snackService = inject(SnackService);
  private _matDialog = inject(MatDialog);
  private _dataInitService = inject(DataInitService);
  private _reminderService = inject(ReminderService);

  // NEW: Subject to track when data reload is complete after sync
  private _dataReloadComplete$ = new Subject<void>();

  syncState$ = this._pfapiService.syncState$;

  syncCfg$: Observable<SyncConfig> = this._globalConfigService.cfg$.pipe(
    map((cfg) => cfg?.sync),
  );
  syncProviderId$: Observable<SyncProviderId | null> = this.syncCfg$.pipe(
    // NOTE: types are compatible
    map((cfg) => cfg.syncProvider as unknown as SyncProviderId | null),
  );

  syncInterval$: Observable<number> = this.syncCfg$.pipe(map((cfg) => cfg.syncInterval));

  isEnabledAndReady$: Observable<boolean> =
    this._pfapiService.isSyncProviderEnabledAndReady$.pipe();
  isSyncInProgress$: Observable<boolean> = this._pfapiService.isSyncInProgress$.pipe();

  _afterCurrentSyncDoneIfAny$: Observable<unknown> = this.isSyncInProgress$.pipe(
    filter((isSyncing) => !isSyncing),
    switchMap(() => this._dataReloadComplete$),
  );

  afterCurrentSyncDoneOrSyncDisabled$: Observable<unknown> = this.isEnabledAndReady$.pipe(
    switchMap((isEnabled) =>
      isEnabled ? this._afterCurrentSyncDoneIfAny$ : of(undefined),
    ),
    first(),
  );

  // TODO move someplace else

  async sync(): Promise<SyncStatus | 'HANDLED_ERROR'> {
    const providerId = await this.syncProviderId$.pipe(take(1)).toPromise();
    if (!providerId) {
      throw new Error('No Sync Provider for sync()');
    }

    try {
      const r = await this._pfapiService.pf.sync();

      switch (r.status) {
        case SyncStatus.InSync:
          return r.status;

        case SyncStatus.UpdateRemote:
        case SyncStatus.UpdateRemoteAll:
          return r.status;

        case SyncStatus.UpdateLocal:
        case SyncStatus.UpdateLocalAll:
          await this._reInitAppAfterDataModelChange();
          this._snackService.open({
            msg: T.F.SYNC.S.SUCCESS_DOWNLOAD,
            type: 'SUCCESS',
          });
          return r.status;

        case SyncStatus.NotConfigured:
          this.configuredAuthForSyncProviderIfNecessary(providerId);
          return r.status;

        case SyncStatus.IncompleteRemoteData:
          return r.status;

        case SyncStatus.Conflict:
          console.log('Sync conflict detected:', {
            remote: r.conflictData?.remote.lastUpdate,
            local: r.conflictData?.local.lastUpdate,
            lastSync: r.conflictData?.local.lastSyncedUpdate,
            conflictData: r.conflictData,
          });

          // Enhanced debugging for vector clock issues
          console.log('CONFLICT DEBUG - Vector Clock Analysis:', {
            localVectorClock: r.conflictData?.local.vectorClock,
            remoteVectorClock: r.conflictData?.remote.vectorClock,
            localLastSyncedVectorClock: r.conflictData?.local.lastSyncedVectorClock,
            localLamport: r.conflictData?.local.localLamport,
            remoteLamport: r.conflictData?.remote.localLamport,
            conflictReason: r.conflictData?.reason,
            additional: r.conflictData?.additional,
          });
          const res = await this._openConflictDialog$(
            r.conflictData as ConflictData,
          ).toPromise();

          if (res === 'USE_LOCAL') {
            console.log('User chose USE_LOCAL, calling uploadAll(true) with force');
            // Use force upload to skip the meta file check and ensure lastUpdate is updated
            await this._pfapiService.pf.uploadAll(true);
            console.log('uploadAll(true) completed');
            return SyncStatus.UpdateRemoteAll;
          } else if (res === 'USE_REMOTE') {
            await this._pfapiService.pf.downloadAll();
            await this._reInitAppAfterDataModelChange();
          }
          console.log({ res });

          return r.status;
      }
    } catch (error: any) {
      console.error(error);

      if (error instanceof AuthFailSPError) {
        this._snackService.open({
          msg: T.F.SYNC.S.INCOMPLETE_CFG,
          type: 'ERROR',
          actionFn: async () => this._matDialog.open(DialogSyncInitialCfgComponent),
          actionStr: T.F.SYNC.S.BTN_CONFIGURE,
        });
        return 'HANDLED_ERROR';
      } else if (error instanceof SyncInvalidTimeValuesError) {
        this._matDialog
          .open(DialogIncoherentTimestampsErrorComponent, {
            disableClose: true,
            autoFocus: false,
          })
          .afterClosed()
          .subscribe(async (res) => {
            if (res === 'FORCE_UPDATE_REMOTE') {
              await this._forceUpload();
            } else if (res === 'FORCE_UPDATE_LOCAL') {
              await this._pfapiService.pf.downloadAll();
              await this._reInitAppAfterDataModelChange();
            }
          });
        return 'HANDLED_ERROR';
      } else if (
        error instanceof RevMismatchForModelError ||
        error instanceof NoRemoteModelFile
      ) {
        console.log(error, Object.keys(error));
        const modelId = error.additionalLog;
        this._matDialog
          .open(DialogIncompleteSyncComponent, {
            data: { modelId },
            disableClose: true,
            autoFocus: false,
          })
          .afterClosed()
          .subscribe((res) => {
            if (res === 'FORCE_UPDATE_REMOTE') {
              this._forceUpload();
            }
          });
        return 'HANDLED_ERROR';
      } else if (error instanceof LockPresentError) {
        this._snackService.open({
          // TODO translate
          msg: T.F.SYNC.S.ERROR_DATA_IS_CURRENTLY_WRITTEN,
          type: 'ERROR',
          actionFn: async () => this._forceUpload(),
          actionStr: T.F.SYNC.S.BTN_FORCE_OVERWRITE,
        });
        return 'HANDLED_ERROR';
      } else if (
        error instanceof DecryptNoPasswordError ||
        error instanceof DecryptError
      ) {
        this._handleDecryptionError();
        return 'HANDLED_ERROR';
      } else if (error instanceof CanNotMigrateMajorDownError) {
        alert(this._translateService.instant(T.F.SYNC.A.REMOTE_MODEL_VERSION_NEWER));
        return 'HANDLED_ERROR';
      } else if (error?.message === 'Sync already in progress') {
        // Silently ignore concurrent sync attempts
        console.log('Sync already in progress, skipping concurrent sync attempt');
        return 'HANDLED_ERROR';
      } else {
        const errStr = getSyncErrorStr(error);
        this._snackService.open({
          // msg: T.F.SYNC.S.UNKNOWN_ERROR,
          msg: errStr,
          type: 'ERROR',
          translateParams: {
            err: errStr,
          },
        });
        return 'HANDLED_ERROR';
      }
    }
  }

  private async _forceUpload(): Promise<void> {
    if (!this._c(this._translateService.instant(T.F.SYNC.C.FORCE_UPLOAD))) {
      return;
    }
    try {
      await this._pfapiService.pf.uploadAll(true);
    } catch (e) {
      const errStr = getSyncErrorStr(e);
      this._snackService.open({
        // msg: T.F.SYNC.S.UNKNOWN_ERROR,
        msg: errStr,
        type: 'ERROR',
        translateParams: {
          err: errStr,
        },
      });
    }
  }

  async configuredAuthForSyncProviderIfNecessary(
    providerId: SyncProviderId,
  ): Promise<{ wasConfigured: boolean }> {
    const provider = await this._pfapiService.pf.getSyncProviderById(providerId);

    if (!provider) {
      return { wasConfigured: false };
    }

    if (!provider.getAuthHelper) {
      return { wasConfigured: false };
    }

    try {
      const { authUrl, codeVerifier, verifyCodeChallenge } =
        await provider.getAuthHelper();
      if (authUrl && codeVerifier && verifyCodeChallenge) {
        const authCode = await this._matDialog
          .open(DialogGetAndEnterAuthCodeComponent, {
            restoreFocus: true,
            data: {
              providerName: provider.id,
              url: authUrl,
            },
          })
          .afterClosed()
          .toPromise();
        if (authCode) {
          const r = await verifyCodeChallenge(authCode);
          await this._pfapiService.pf.setPrivateCfgForSyncProvider(provider.id, r);
          // NOTE: exec sync afterward; promise not awaited
          setTimeout(() => {
            this.sync();
          }, 1000);
          return { wasConfigured: true };
        } else {
          return { wasConfigured: false };
        }
      }
    } catch (error) {
      console.error(error);
      this._snackService.open({
        // TODO don't limit snack to dropbox
        msg: T.F.DROPBOX.S.UNABLE_TO_GENERATE_PKCE_CHALLENGE,
        type: 'ERROR',
      });
      return { wasConfigured: false };
    }
    return { wasConfigured: false };
  }

  private _handleDecryptionError(): void {
    this._matDialog
      .open(DialogHandleDecryptErrorComponent, {
        disableClose: true,
        autoFocus: false,
      })
      .afterClosed()
      .subscribe(({ isReSync, isForceUpload }) => {
        if (isReSync) {
          this.sync();
        }
        if (isForceUpload) {
          this._forceUpload();
        }
      });
  }

  private async _reInitAppAfterDataModelChange(): Promise<void> {
    console.log('Starting data re-initialization after sync...');

    try {
      await Promise.all([
        this._dataInitService.reInit(true),
        this._reminderService.reloadFromDatabase(),
      ]);

      console.log('Data re-initialization complete');
      // Signal that data reload is complete
      this._dataReloadComplete$.next();
    } catch (error) {
      console.error('Error during data re-initialization:', error);
      throw error;
    }
  }

  private _c(str: string): boolean {
    return confirm(this._translateService.instant(str));
  }

  private lastConflictDialog?: MatDialogRef<any, any>;

  private _openConflictDialog$(
    conflictData: ConflictData,
  ): Observable<DialogConflictResolutionResult> {
    if (this.lastConflictDialog) {
      this.lastConflictDialog.close();
    }
    this.lastConflictDialog = this._matDialog.open(DialogSyncConflictComponent, {
      restoreFocus: true,
      autoFocus: false,
      disableClose: true,
      data: conflictData,
    });
    return this.lastConflictDialog.afterClosed();
  }
}

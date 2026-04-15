#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <dispatch/dispatch.h>
#include <stdbool.h>
#include <stdint.h>

bool openxterm_can_evaluate_biometrics(void) {
  @autoreleasepool {
    LAContext *context = [[LAContext alloc] init];
    NSError *error = nil;
    return [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:&error];
  }
}

bool openxterm_can_evaluate_device_authentication(void) {
  @autoreleasepool {
    LAContext *context = [[LAContext alloc] init];
    NSError *error = nil;
    return [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error];
  }
}

bool openxterm_request_system_auth(const uint8_t *reason_ptr, uintptr_t reason_len, bool prefer_biometrics) {
  @autoreleasepool {
    NSData *reasonData = nil;
    if (reason_ptr != NULL && reason_len > 0) {
      reasonData = [NSData dataWithBytes:reason_ptr length:(NSUInteger)reason_len];
    } else {
      reasonData = [NSData data];
    }

    NSString *reason = [[NSString alloc] initWithData:reasonData encoding:NSUTF8StringEncoding];
    if (reason == nil || reason.length == 0) {
      reason = @"Unlock OpenXTerm";
    }

    LAContext *context = [[LAContext alloc] init];
    LAPolicy policy = prefer_biometrics ? LAPolicyDeviceOwnerAuthenticationWithBiometrics : LAPolicyDeviceOwnerAuthentication;
    NSError *error = nil;
    if (![context canEvaluatePolicy:policy error:&error]) {
      if (prefer_biometrics && [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) {
        policy = LAPolicyDeviceOwnerAuthentication;
      } else {
        return false;
      }
    }

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block BOOL granted = NO;

    [context evaluatePolicy:policy
            localizedReason:reason
                      reply:^(BOOL success, NSError * _Nullable authError) {
      (void)authError;
      granted = success;
      dispatch_semaphore_signal(semaphore);
    }];

    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
    return granted;
  }
}

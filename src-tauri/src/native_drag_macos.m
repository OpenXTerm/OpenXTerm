#import <AppKit/AppKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <stdint.h>

extern int openxterm_native_drag_write_file(
  const char *session_json,
  const char *remote_path,
  const char *destination_path,
  const char *transfer_id,
  const char *file_kind
);

@interface OXTFilePromiseDragSource : NSObject <NSFilePromiseProviderDelegate, NSDraggingSource>
@property(nonatomic, copy) NSString *sessionJson;
@property(nonatomic, copy) NSString *remotePath;
@property(nonatomic, copy) NSString *fileName;
@property(nonatomic, copy) NSString *transferId;
@property(nonatomic, copy) NSString *fileKind;
@end

static NSMutableArray<OXTFilePromiseDragSource *> *OXTActiveDragSources(void) {
  static NSMutableArray<OXTFilePromiseDragSource *> *sources = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    sources = [NSMutableArray array];
  });
  return sources;
}

static NSImage *OXTDragIconForFileName(NSString *fileName) {
  NSImage *icon = nil;

  if (@available(macOS 12.0, *)) {
    NSString *extension = [fileName pathExtension];
    UTType *contentType = extension.length > 0
      ? [UTType typeWithFilenameExtension:extension]
      : UTTypeData;
    icon = [[NSWorkspace sharedWorkspace] iconForContentType:contentType ?: UTTypeData];
  }

  if (icon == nil) {
    icon = [NSImage imageNamed:NSImageNameMultipleDocuments];
  }

  return [icon copy];
}

@implementation OXTFilePromiseDragSource

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  return NSDragOperationCopy;
}

- (void)draggingSession:(NSDraggingSession *)session
    endedAtPoint:(NSPoint)screenPoint
    operation:(NSDragOperation)operation {
  // Keep the source alive until NSFilePromiseProvider finishes writing the file.
  // Finder may request the promised file after the visual dragging session ends.
}

- (NSString *)filePromiseProvider:(NSFilePromiseProvider *)filePromiseProvider
    fileNameForType:(NSString *)fileType {
  return self.fileName;
}

- (void)filePromiseProvider:(NSFilePromiseProvider *)filePromiseProvider
    writePromiseToURL:(NSURL *)url
    completionHandler:(void (^)(NSError * _Nullable errorOrNil))completionHandler {
  NSURL *targetURL = url;
  NSNumber *isDirectory = nil;
  if ([url getResourceValue:&isDirectory forKey:NSURLIsDirectoryKey error:nil] && [isDirectory boolValue]) {
    targetURL = [url URLByAppendingPathComponent:self.fileName];
  }

  NSString *sessionJson = [self.sessionJson copy];
  NSString *remotePath = [self.remotePath copy];
  NSString *destinationPath = [[targetURL path] copy];
  NSString *transferId = [self.transferId copy];
  NSString *fileKind = [self.fileKind copy];
  OXTFilePromiseDragSource *source = self;

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    int result = openxterm_native_drag_write_file(
      [sessionJson UTF8String],
      [remotePath UTF8String],
      [destinationPath UTF8String],
      [transferId UTF8String],
      [fileKind UTF8String]
    );

    dispatch_async(dispatch_get_main_queue(), ^{
      if (result == 0) {
        completionHandler(nil);
      } else {
        NSError *error = [NSError errorWithDomain:@"OpenXTermNativeDrag"
                                             code:result
                                         userInfo:@{NSLocalizedDescriptionKey: @"OpenXTerm failed to write promised remote file"}];
        completionHandler(error);
      }

      [OXTActiveDragSources() removeObject:source];
    });
  });
}

@end

bool openxterm_start_file_promise_drag_v2(
  void *ns_window_ptr,
  const uint8_t *session_json,
  uintptr_t session_json_len,
  const uint8_t *entries_json,
  uintptr_t entries_json_len,
  double client_x,
  double client_y
) {
  @autoreleasepool {
    NSWindow *window = (__bridge NSWindow *)ns_window_ptr;
    if (window == nil
        || session_json == NULL
        || entries_json == NULL
        || session_json_len == 0
        || entries_json_len == 0) {
      return false;
    }

    NSView *contentView = [window contentView];
    if (contentView == nil) {
      return false;
    }

    NSRect bounds = [contentView bounds];
    NSPoint point = NSMakePoint(client_x, NSHeight(bounds) - client_y);
    NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged
                                        location:point
                                   modifierFlags:0
                                       timestamp:[NSDate timeIntervalSinceReferenceDate]
                                    windowNumber:[window windowNumber]
                                         context:nil
                                     eventNumber:0
                                      clickCount:1
                                        pressure:1.0];
    if (event == nil) {
      return false;
    }

    NSData *sessionData = [NSData dataWithBytes:session_json length:(NSUInteger)session_json_len];
    NSData *entriesData = [NSData dataWithBytes:entries_json length:(NSUInteger)entries_json_len];
    NSString *sessionJsonString = [[NSString alloc] initWithData:sessionData encoding:NSUTF8StringEncoding];
    NSString *entriesJsonString = [[NSString alloc] initWithData:entriesData encoding:NSUTF8StringEncoding];
    if (sessionJsonString == nil || entriesJsonString == nil) {
      return false;
    }

    NSError *jsonError = nil;
    id parsedEntries = [NSJSONSerialization JSONObjectWithData:entriesData options:0 error:&jsonError];
    if (jsonError != nil || ![parsedEntries isKindOfClass:[NSArray class]]) {
      return false;
    }

    NSMutableArray<NSDraggingItem *> *dragItems = [NSMutableArray array];
    OXTFilePromiseDragSource *dragSessionSource = nil;
    for (NSDictionary *entry in (NSArray *)parsedEntries) {
      if (![entry isKindOfClass:[NSDictionary class]]) {
        continue;
      }

      NSString *remotePath = entry[@"remotePath"];
      NSString *fileName = entry[@"fileName"];
      NSString *transferId = entry[@"transferId"];
      NSString *fileKind = entry[@"kind"];
      if (![remotePath isKindOfClass:[NSString class]]
          || ![fileName isKindOfClass:[NSString class]]
          || ![transferId isKindOfClass:[NSString class]]
          || ![fileKind isKindOfClass:[NSString class]]) {
        continue;
      }

      OXTFilePromiseDragSource *source = [[OXTFilePromiseDragSource alloc] init];
      source.sessionJson = sessionJsonString;
      source.remotePath = remotePath;
      source.fileName = fileName;
      source.transferId = transferId;
      source.fileKind = fileKind;
      [OXTActiveDragSources() addObject:source];
      if (dragSessionSource == nil) {
        dragSessionSource = source;
      }

      NSString *fileType = [fileKind isEqualToString:@"folder"] ? @"public.folder" : @"public.data";
      NSFilePromiseProvider *provider = [[NSFilePromiseProvider alloc] initWithFileType:fileType delegate:source];
      NSDraggingItem *dragItem = [[NSDraggingItem alloc] initWithPasteboardWriter:provider];

      NSImage *icon = [fileKind isEqualToString:@"folder"]
        ? [[NSImage imageNamed:NSImageNameFolder] copy]
        : OXTDragIconForFileName(source.fileName);
      [icon setSize:NSMakeSize(32, 32)];

      NSInteger index = [dragItems count];
      NSRect frame = NSMakeRect(point.x - 16 + (index * 6), point.y - 16 - (index * 6), 32, 32);
      [dragItem setDraggingFrame:frame contents:icon];
      [dragItems addObject:dragItem];
    }

    if ([dragItems count] == 0) {
      return false;
    }

    NSDraggingSession *session = [contentView beginDraggingSessionWithItems:dragItems event:event source:dragSessionSource];
    [session setAnimatesToStartingPositionsOnCancelOrFail:YES];
    return true;
  }
}

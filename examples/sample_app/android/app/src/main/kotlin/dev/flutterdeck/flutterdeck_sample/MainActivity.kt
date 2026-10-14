package dev.flutterdeck.flutterdeck_sample

import android.util.Log
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Writes under its own tag so the logcat feed shows native lines, not only "flutter".
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "flutterdeck/sample")
            .setMethodCallHandler { call, result ->
                if (call.method == "log") {
                    Log.i("FlutterDeckSample", call.arguments as? String ?: "")
                    result.success(null)
                } else {
                    result.notImplemented()
                }
            }
    }
}

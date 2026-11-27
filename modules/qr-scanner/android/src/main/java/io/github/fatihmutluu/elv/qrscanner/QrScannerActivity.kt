package io.github.fatihmutluu.elv.qrscanner

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Size
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Full-screen dark CameraX + ZXing QR code scanner activity (`#0A0B0F` Cinema Quietude chrome)
 * used on handheld Android phone/tablet builds (`#510`).
 */
class QrScannerActivity : ComponentActivity() {
  companion object {
    const val EXTRA_QR_TEXT = "elv_qr_text"
    private const val STATE_PERMISSION_REQUESTED = "elv_qr_permission_requested"
    private val CHROME_BG_COLOR = Color.rgb(10, 11, 15)
    private val SCRIM_COLOR = Color.argb(143, 10, 11, 15)
    private val BUTTON_BG_COLOR = Color.argb(184, 10, 11, 15)
    private val BUTTON_BORDER_COLOR = Color.argb(46, 255, 255, 255)
    private val TORCH_ACTIVE_COLOR = Color.rgb(250, 204, 21)
  }

  private val resultDelivered = AtomicBoolean(false)
  private val cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "ElvQrScannerAnalyzer").apply { isDaemon = true }
  }
  private val frameDecoder = QrCodeFrameDecoder()
  private var reusableLuminanceBuffer: ByteArray? = null

  private lateinit var previewView: PreviewView
  private lateinit var controlsContainer: FrameLayout
  private lateinit var torchButton: ChromeIconButton
  private lateinit var closeButton: ChromeIconButton

  private var cameraProvider: ProcessCameraProvider? = null
  private var boundCamera: Camera? = null
  private var torchEnabled = false
  private var permissionRequested = false

  private val permissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission(),
  ) { granted ->
    if (granted) {
      startCamera()
    } else {
      finishCancelled()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars = false

    val root = FrameLayout(this).apply {
      setBackgroundColor(CHROME_BG_COLOR)
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      )
    }

    previewView = PreviewView(this).apply {
      implementationMode = PreviewView.ImplementationMode.COMPATIBLE
      scaleType = PreviewView.ScaleType.FILL_CENTER
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      )
    }
    root.addView(previewView)

    val overlay = ViewfinderOverlayView(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      )
    }
    root.addView(overlay)

    controlsContainer = FrameLayout(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      )
    }
    val buttonSize = dpToPx(44)
    val marginH = dpToPx(16)
    val marginTop = dpToPx(14)

    torchButton = ChromeIconButton(this, ChromeIconButton.Kind.TORCH).apply {
      visibility = View.GONE
      contentDescription = "Toggle flashlight"
      setOnClickListener { toggleTorch() }
    }
    controlsContainer.addView(
      torchButton,
      FrameLayout.LayoutParams(buttonSize, buttonSize, Gravity.TOP or Gravity.START).apply {
        setMargins(marginH, marginTop, marginH, 0)
      },
    )

    closeButton = ChromeIconButton(this, ChromeIconButton.Kind.CLOSE).apply {
      contentDescription = "Close QR scanner"
      setOnClickListener { finishCancelled() }
    }
    controlsContainer.addView(
      closeButton,
      FrameLayout.LayoutParams(buttonSize, buttonSize, Gravity.TOP or Gravity.END).apply {
        setMargins(marginH, marginTop, marginH, 0)
      },
    )

    ViewCompat.setOnApplyWindowInsetsListener(controlsContainer) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }

    root.addView(controlsContainer)
    setContentView(root)

    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          finishCancelled()
        }
      },
    )

    permissionRequested = savedInstanceState?.getBoolean(STATE_PERMISSION_REQUESTED, false) ?: false

    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      startCamera()
    } else if (!permissionRequested) {
      permissionRequested = true
      permissionLauncher.launch(Manifest.permission.CAMERA)
    }
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    outState.putBoolean(STATE_PERMISSION_REQUESTED, permissionRequested)
  }

  override fun onDestroy() {
    runCatching { boundCamera?.cameraControl?.enableTorch(false) }
    runCatching { cameraProvider?.unbindAll() }
    boundCamera = null
    cameraProvider = null
    cameraExecutor.shutdownNow()
    super.onDestroy()
  }

  private fun startCamera() {
    val providerFuture = ProcessCameraProvider.getInstance(this)
    providerFuture.addListener(
      {
        if (isFinishing || isDestroyed || resultDelivered.get()) return@addListener
        try {
          val provider = providerFuture.get()
          cameraProvider = provider
          val selector = when {
            provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) -> CameraSelector.DEFAULT_BACK_CAMERA
            provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) -> CameraSelector.DEFAULT_FRONT_CAMERA
            else -> null
          }
          if (selector == null) {
            finishCancelled()
            return@addListener
          }

          val preview = Preview.Builder().build().apply {
            surfaceProvider = previewView.surfaceProvider
          }

          val resolutionSelector = ResolutionSelector.Builder()
            .setResolutionStrategy(
              ResolutionStrategy(
                Size(1280, 720),
                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
              ),
            )
            .build()

          val imageAnalysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setResolutionSelector(resolutionSelector)
            .build()
          imageAnalysis.setAnalyzer(cameraExecutor, ::analyzeFrame)

          provider.unbindAll()
          val camera = provider.bindToLifecycle(this, selector, preview, imageAnalysis)
          boundCamera = camera
          torchButton.visibility = if (camera.cameraInfo.hasFlashUnit()) View.VISIBLE else View.GONE
        } catch (_: Exception) {
          finishCancelled()
        }
      },
      ContextCompat.getMainExecutor(this),
    )
  }

  private fun analyzeFrame(imageProxy: ImageProxy) {
    try {
      if (resultDelivered.get()) return
      val plane = imageProxy.planes.firstOrNull() ?: return
      val yBytes = extractCompactLuminance(
        buffer = plane.buffer,
        width = imageProxy.width,
        height = imageProxy.height,
        rowStride = plane.rowStride,
        pixelStride = plane.pixelStride,
        reuse = reusableLuminanceBuffer,
      )
      reusableLuminanceBuffer = yBytes
      val decoded = frameDecoder.decode(
        yData = yBytes,
        width = imageProxy.width,
        height = imageProxy.height,
      ) ?: return

      if (resultDelivered.compareAndSet(false, true)) {
        runOnUiThread {
          if (!isFinishing && !isDestroyed) {
            deliverSuccessAndFinish(decoded)
          }
        }
      }
    } finally {
      imageProxy.close()
    }
  }

  private fun toggleTorch() {
    val camera = boundCamera ?: return
    if (!camera.cameraInfo.hasFlashUnit()) return
    val next = !torchEnabled
    torchEnabled = next
    torchButton.setActive(next)
    camera.cameraControl.enableTorch(next)
  }

  private fun deliverSuccessAndFinish(qrText: String) {
    torchEnabled = false
    runCatching { boundCamera?.cameraControl?.enableTorch(false) }
    runCatching { window.decorView.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK) }
    runCatching { cameraProvider?.unbindAll() }
    setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_QR_TEXT, qrText))
    finish()
  }

  private fun finishCancelled() {
    if (!resultDelivered.compareAndSet(false, true)) return
    torchEnabled = false
    runCatching { boundCamera?.cameraControl?.enableTorch(false) }
    runCatching { cameraProvider?.unbindAll() }
    setResult(Activity.RESULT_CANCELED)
    finish()
  }

  private fun dpToPx(dp: Int): Int =
    TypedValue.applyDimension(
      TypedValue.COMPLEX_UNIT_DIP,
      dp.toFloat(),
      resources.displayMetrics,
    ).toInt()

  private class ViewfinderOverlayView(context: Context) : View(context) {
    private val scrimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = SCRIM_COLOR
      style = Paint.Style.FILL
    }
    private val clearPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    }
    private val cornerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      style = Paint.Style.STROKE
      strokeWidth = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP,
        3f,
        context.resources.displayMetrics,
      )
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
    }
    private val cutoutRect = RectF()
    private val cornerPath = Path()
    private val cutoutRadius = TypedValue.applyDimension(
      TypedValue.COMPLEX_UNIT_DIP,
      16f,
      context.resources.displayMetrics,
    )
    private val armLength = TypedValue.applyDimension(
      TypedValue.COMPLEX_UNIT_DIP,
      24f,
      context.resources.displayMetrics,
    )
    private val minSide = TypedValue.applyDimension(
      TypedValue.COMPLEX_UNIT_DIP,
      180f,
      context.resources.displayMetrics,
    )
    private val maxSide = TypedValue.applyDimension(
      TypedValue.COMPLEX_UNIT_DIP,
      280f,
      context.resources.displayMetrics,
    )

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      val w = width.toFloat()
      val h = height.toFloat()
      if (w <= 0f || h <= 0f) return

      val side = minOf(maxOf(minOf(w, h) * 0.62f, minSide), maxSide)
      val left = (w - side) * 0.5f
      val top = (h - side) * 0.5f
      val right = left + side
      val bottom = top + side
      cutoutRect.set(left, top, right, bottom)

      val saveCount = canvas.saveLayer(0f, 0f, w, h, null)
      canvas.drawRect(0f, 0f, w, h, scrimPaint)
      canvas.drawRoundRect(cutoutRect, cutoutRadius, cutoutRadius, clearPaint)
      canvas.restoreToCount(saveCount)

      cornerPath.reset()
      val r = cutoutRadius
      // Top-left
      cornerPath.moveTo(left, top + armLength)
      cornerPath.lineTo(left, top + r)
      cornerPath.quadTo(left, top, left + r, top)
      cornerPath.lineTo(left + armLength, top)
      // Top-right
      cornerPath.moveTo(right - armLength, top)
      cornerPath.lineTo(right - r, top)
      cornerPath.quadTo(right, top, right, top + r)
      cornerPath.lineTo(right, top + armLength)
      // Bottom-right
      cornerPath.moveTo(right, bottom - armLength)
      cornerPath.lineTo(right, bottom - r)
      cornerPath.quadTo(right, bottom, right - r, bottom)
      cornerPath.lineTo(right - armLength, bottom)
      // Bottom-left
      cornerPath.moveTo(left + armLength, bottom)
      cornerPath.lineTo(left + r, bottom)
      cornerPath.quadTo(left, bottom, left, bottom - r)
      cornerPath.lineTo(left, bottom - armLength)

      canvas.drawPath(cornerPath, cornerPaint)
    }
  }

  private class ChromeIconButton(
    context: Context,
    private val kind: Kind,
  ) : View(context) {
    enum class Kind {
      CLOSE,
      TORCH,
    }

    private var active = false
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      style = Paint.Style.STROKE
      strokeWidth = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP,
        2f,
        context.resources.displayMetrics,
      )
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
    }
    private val iconPath = Path()

    init {
      isClickable = true
      isFocusable = true
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(BUTTON_BG_COLOR)
        setStroke(
          TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            1f,
            context.resources.displayMetrics,
          ).toInt(),
          BUTTON_BORDER_COLOR,
        )
      }
    }

    fun setActive(enabled: Boolean) {
      active = enabled
      strokePaint.color = if (enabled) TORCH_ACTIVE_COLOR else Color.WHITE
      invalidate()
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      val cx = width * 0.5f
      val cy = height * 0.5f
      val r = minOf(width, height) * 0.18f

      when (kind) {
        Kind.CLOSE -> {
          canvas.drawLine(cx - r, cy - r, cx + r, cy + r, strokePaint)
          canvas.drawLine(cx + r, cy - r, cx - r, cy + r, strokePaint)
        }
        Kind.TORCH -> {
          iconPath.reset()
          iconPath.moveTo(cx + r * 0.25f, cy - r * 1.15f)
          iconPath.lineTo(cx - r * 0.65f, cy + r * 0.08f)
          iconPath.lineTo(cx + r * 0.05f, cy + r * 0.08f)
          iconPath.lineTo(cx - r * 0.25f, cy + r * 1.15f)
          iconPath.lineTo(cx + r * 0.65f, cy - r * 0.08f)
          iconPath.lineTo(cx - r * 0.05f, cy - r * 0.08f)
          iconPath.close()
          strokePaint.style = if (active) Paint.Style.FILL_AND_STROKE else Paint.Style.STROKE
          canvas.drawPath(iconPath, strokePaint)
        }
      }
    }
  }
}
